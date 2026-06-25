/**
 * Universal agent-session scanner/reconciler.
 *
 * The guaranteed floor of session tracking: walks every registered agent's
 * `sessions` descriptor (transcripts on disk), upserts each discovered session
 * into the sessions DB with its real timestamps (UNATTRIBUTED — discovered
 * sessions are not auto-bound to any assignment; an explicit grab/track opens
 * the engagement edge), derives liveness (a process holding the transcript open
 * via lsof, else mtime freshness), and sweeps stale
 * `active` rows to `stopped` with `ended` backdated to the transcript's last
 * mtime. Hooks and the launch path make registration instant where supported;
 * this scanner guarantees eventual consistency for everything else.
 *
 * Runs inside the dashboard's autodiscovery interval and standalone via
 * `syntaur session scan`. Callers must `initSessionDb()` first.
 */

import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileExists } from '../utils/fs.js';
import { canonicalPath } from '../utils/path-canon.js';
import { readConfig, type SessionAutoTrack } from '../utils/config.js';
import { isSafeSessionId } from '../utils/session-id.js';
import { AGENT_TARGETS } from '../targets/registry.js';
import type { AgentTarget, DiscoveredSession } from '../targets/types.js';
import { getSessionDb } from '../dashboard/session-db.js';
import {
  appendSession,
  getSessionById,
  updateSessionStatus,
  livenessStopSession,
} from '../dashboard/agent-sessions.js';
import { getOpenEngagement } from '../db/engagement-db.js';
import { getCumulativeTokenSource, type TokenSnapshot } from '../db/engagement-tokens.js';
import { getAgentViewSource, type AgentViewSource } from './agent-view.js';
import type { ActivityState, AgentSessionStatus } from '../dashboard/types.js';

const execFileAsync = promisify(execFile);

const FRESH_MTIME_MS = 5 * 60 * 1000;
const LSOF_CHUNK = 64;
const WATERMARK_KEY = 'sessions_scan_last_ms';

export interface ScannerDeps {
  /** Targets to scan. Defaults to built-ins with a `sessions` descriptor. */
  targets?: AgentTarget[];
  /** Per-target transcript-root override keyed by target id (tests). */
  roots?: Record<string, string>;
  /** Override the configured `session.autoTrack` (skips readConfig). */
  autoTrack?: SessionAutoTrack;
  now?: () => number;
  statMtimeMs?: (path: string) => number | null;
  /** Returns the subset of `files` currently held open by some process. */
  openFiles?: (files: string[]) => Promise<Set<string>>;
  isPidAlive?: (pid: number) => boolean;
  pidStartedAt?: (pid: number) => string | null;
  /**
   * Agent-View liveness probe. Defaults to the module seam (`claude agents
   * --json`, best-effort). Tests inject a hermetic map; absence ≠ death.
   */
  agentView?: AgentViewSource;
}

export interface ScanSummary {
  /** Sessions discovered on disk (post id-validation). */
  discovered: number;
  /** New rows inserted. */
  inserted: number;
  /** `stopped` rows revived to `active` on live-process evidence. */
  revived: number;
  /** `active` rows swept to `stopped`. */
  swept: number;
  /** Discovered sessions skipped (workspaces-only gating). */
  skipped: number;
  /** Whether any DB row changed (drives the dashboard broadcast). */
  changed: boolean;
}

function emptySummary(): ScanSummary {
  return { discovered: 0, inserted: 0, revived: 0, swept: 0, skipped: 0, changed: false };
}

function defaultStatMtimeMs(path: string): number | null {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

function defaultIsPidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function defaultPidStartedAt(pid: number): string | null {
  if (!Number.isFinite(pid) || pid <= 0) return null;
  try {
    const out = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const trimmed = out.trim();
    return trimmed === '' ? null : trimmed;
  } catch {
    return null;
  }
}

/**
 * Which of `files` are currently held open by some process, via batched
 * `lsof -Fn`. lsof exits non-zero when any listed file is NOT open, but still
 * prints the open ones — so parse stdout from both resolve and reject paths.
 * Degrades to "none open" when lsof is unavailable (mtime freshness remains).
 */
async function defaultOpenFiles(files: string[]): Promise<Set<string>> {
  const open = new Set<string>();
  for (let i = 0; i < files.length; i += LSOF_CHUNK) {
    const chunk = files.slice(i, i + LSOF_CHUNK);
    let stdout = '';
    try {
      const result = await execFileAsync('lsof', ['-Fn', '--', ...chunk], {
        maxBuffer: 8 * 1024 * 1024,
      });
      stdout = result.stdout;
    } catch (err) {
      const maybe = (err as { stdout?: unknown }).stdout;
      stdout = typeof maybe === 'string' ? maybe : '';
    }
    for (const line of stdout.split('\n')) {
      if (line.startsWith('n') && line.length > 1) open.add(line.slice(1));
    }
  }
  return open;
}

/**
 * Canonicalize (realpath) every member of an open-file set so a transcript can
 * be matched regardless of which spelling of a symlinked root it carries.
 * macOS `lsof` canonicalizes symlinked roots (`/var` → `/private/var`,
 * `/tmp` → `/private/tmp`), so the raw open-set spelling can differ from a
 * discovered `transcriptPath`; comparing both sides realpath'd keeps a live
 * transcript under a symlinked root from being swept to stopped/stale. Applied
 * at the consumption point (not inside `defaultOpenFiles`) so an injected
 * `openFiles` dep — which replaces `defaultOpenFiles` entirely — is normalized
 * too. `canonicalPath` never throws (non-existent paths fall back to a resolved
 * spelling), so this is safe for already-swept/deleted transcripts.
 */
function canonicalizeOpenSet(open: Set<string>): Set<string> {
  const out = new Set<string>();
  for (const p of open) out.add(canonicalPath(p));
  return out;
}

/**
 * Whether `cwd` is a Syntaur workspace — i.e. `<cwd>/.syntaur/context.json`
 * exists — for the `autoTrack === 'workspaces-only'` gate ONLY.
 *
 * Intentional behavior change: the scanner no longer reads
 * projectSlug/assignmentSlug out of context.json to auto-bind a discovered
 * session to the cwd's assignment scalar. That auto-binding clobbered the
 * active assignment across multiple co-located sessions/assignments. Discovered
 * sessions are now inserted UNATTRIBUTED (project/assignment null); a session is
 * bound to an assignment only when it explicitly grabs/tracks one (which opens
 * an engagement edge). We still detect the workspace marker so workspaces-only
 * autoTrack keeps skipping bare (non-workspace) cwds.
 */
async function isWorkspace(
  cwd: string,
  cache: Map<string, boolean>,
): Promise<boolean> {
  if (cache.has(cwd)) return cache.get(cwd)!;
  const path = resolve(cwd, '.syntaur', 'context.json');
  const present = await fileExists(path);
  cache.set(cwd, present);
  return present;
}

function readWatermark(): number | null {
  const db = getSessionDb();
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(WATERMARK_KEY) as
    | { value: string }
    | undefined;
  if (!row) return null;
  const parsed = Number.parseInt(row.value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function writeWatermark(ms: number): void {
  const db = getSessionDb();
  db.prepare(
    'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(WATERMARK_KEY, String(ms));
}

interface Discovered extends DiscoveredSession {
  agent: string;
}

/**
 * One reconcile pass. `full: true` ignores the incremental mtime watermark
 * (the first run is always full — that's the retroactive backfill).
 */
export async function scanSessions(
  opts: { full?: boolean } = {},
  deps: ScannerDeps = {},
): Promise<ScanSummary> {
  const summary = emptySummary();

  const autoTrack = deps.autoTrack ?? (await readConfig()).session.autoTrack;
  if (autoTrack === 'off') return summary;

  const now = deps.now ?? (() => Date.now());
  const statMtimeMs = deps.statMtimeMs ?? defaultStatMtimeMs;
  const openFiles = deps.openFiles ?? defaultOpenFiles;
  const isPidAlive = deps.isPidAlive ?? defaultIsPidAlive;
  const pidStartedAt = deps.pidStartedAt ?? defaultPidStartedAt;
  const agentView = deps.agentView ?? getAgentViewSource();
  const targets = (deps.targets ?? AGENT_TARGETS).filter((t) => t.sessions !== undefined);

  const scanStartMs = now();
  const watermark = opts.full ? null : readWatermark();

  // Agent-View liveness probe (best-effort, awaited BEFORE the sync sweep). A
  // session reported here is LIVE: an additional keep-alive that also revives a
  // wrongly-stopped row and populates `activity`. ABSENCE is never death
  // evidence — the pid/transcript test still decides death (Decision 5).
  let liveActivity: Map<string, ActivityState>;
  try {
    liveActivity = await agentView();
  } catch {
    liveActivity = new Map();
  }

  // --- (1) Discover sessions from every descriptor.
  const discovered: Discovered[] = [];
  for (const target of targets) {
    const walk = target.sessions!.walk({
      root: deps.roots?.[target.id],
      sinceMtimeMs: watermark ?? undefined,
    });
    for await (const session of walk) {
      if (!isSafeSessionId(session.sessionId)) continue;
      discovered.push({ ...session, agent: target.id });
    }
  }
  summary.discovered = discovered.length;

  // --- (2) Liveness evidence: one batched lsof pass over all transcripts.
  const openSet = canonicalizeOpenSet(
    await openFiles(discovered.map((d) => d.transcriptPath)),
  );

  // --- (3) Upsert each discovered session.
  const workspaceCache = new Map<string, boolean>();
  for (const d of discovered) {
    const isWs = await isWorkspace(d.cwd, workspaceCache);
    if (autoTrack === 'workspaces-only' && !isWs) {
      summary.skipped += 1;
      continue;
    }

    const mtime = statMtimeMs(d.transcriptPath);
    const heldOpen = openSet.has(canonicalPath(d.transcriptPath));
    // Agent-View live evidence is an ADDITIONAL keep-alive/revive signal (like
    // heldOpen). Absence is NOT death evidence (handled at the sweep).
    const agentViewLive = liveActivity.has(d.sessionId);
    const isLive =
      heldOpen || agentViewLive || (mtime !== null && now() - mtime < FRESH_MTIME_MS);

    // Discovery INSERTS and REVIVES; it never downgrades. An existing row keeps
    // its status here — active→stopped is owned exclusively by the sweep below,
    // which weighs pid evidence first (a live-but-idle session has a stale
    // transcript and must NOT be stopped). Only new rows take the liveness
    // verdict directly (dead-session backfill inserts as stopped).
    const prev = getSessionById(d.sessionId);
    const status: AgentSessionStatus = isLive ? 'active' : (prev?.status ?? 'stopped');
    const started =
      d.startedAt ?? (mtime !== null ? new Date(mtime).toISOString() : new Date(now()).toISOString());

    await appendSession(
      '',
      {
        sessionId: d.sessionId,
        // Auto-discovered sessions are UNATTRIBUTED: the scanner no longer binds
        // them to the cwd context.json assignment scalar (see isWorkspace). An
        // explicit grab/track opens an engagement edge to attribute them.
        projectSlug: null,
        assignmentSlug: null,
        agent: d.agent,
        started,
        status,
        path: d.cwd,
        description: null,
        transcriptPath: d.transcriptPath,
        pid: null,
        pidStartedAt: null,
        originalHeadSha: null,
      },
      // Narrow revival rule: only LIVE-PROCESS evidence (a process holding the
      // transcript open) OR Agent-View live evidence may flip a stopped row back
      // to active. mtime freshness alone must not — a session stopped moments ago
      // by its SessionEnd hook still has a fresh transcript for up to 5 minutes
      // and would flap back to active. `completed` always sticks (appendSession
      // enforces).
      { reviveStopped: heldOpen || agentViewLive },
    );

    // Backdate `ended` for rows that just landed (or already sat) in `stopped`
    // without an end timestamp. Never touches rows that already have one.
    if (!isLive) {
      const after = getSessionById(d.sessionId);
      if (after && after.status === 'stopped' && !after.ended) {
        const endedAt = d.endedAt ?? (mtime !== null ? new Date(mtime).toISOString() : undefined);
        await updateSessionStatus('', d.sessionId, 'stopped', endedAt);
      }
    }

    if (!prev) {
      summary.inserted += 1;
      summary.changed = true;
    } else {
      // Revival happens on heldOpen OR Agent-View live evidence (the flag
      // above). Project/assignment are no longer auto-bound from context.json
      // here, so there is no slug-fill path to mark as changed.
      if (prev.status === 'stopped' && (heldOpen || agentViewLive)) {
        summary.revived += 1;
        summary.changed = true;
      }
    }
  }

  // --- (3b) Persist Agent-View `activity` onto existing rows. Liveness metadata
  // only — never status. Guarded by `IS NOT` so an unchanged value is not a
  // (broadcast-triggering) write.
  const db = getSessionDb();
  if (liveActivity.size > 0) {
    const setActivity = db.prepare(
      "UPDATE sessions SET activity = ?, updated_at = datetime('now') WHERE session_id = ? AND activity IS NOT ?",
    );
    for (const [sid, activity] of liveActivity) {
      if (setActivity.run(activity, sid, activity).changes > 0) summary.changed = true;
    }
  }

  // --- (4) Sweep: every `active` DB row with no remaining liveness evidence
  // flips to `stopped` AND its dangling open engagement is closed `liveness_gc`
  // (the GC), `ended` backdated to the transcript's last mtime.
  const activeRows = db
    .prepare("SELECT session_id, pid, pid_started_at, transcript_path FROM sessions WHERE status = 'active'")
    .all() as Array<{
    session_id: string;
    pid: number | null;
    pid_started_at: string | null;
    transcript_path: string | null;
  }>;

  const sweepCandidates: Array<{ sessionId: string; transcriptPath: string | null }> = [];
  for (const row of activeRows) {
    // Agent-View live evidence is an additional keep-alive: a session Claude
    // reports live is never swept, even with a stale pid/transcript (Decision 5).
    if (liveActivity.has(row.session_id)) continue;
    if (row.pid !== null) {
      const alive =
        isPidAlive(row.pid) &&
        (!row.pid_started_at || (pidStartedAt(row.pid) ?? row.pid_started_at) === row.pid_started_at);
      if (alive) continue;
    }
    if (row.transcript_path) {
      sweepCandidates.push({ sessionId: row.session_id, transcriptPath: row.transcript_path });
    } else if (row.pid !== null) {
      // pid evidence says dead and there is no transcript to check.
      sweepCandidates.push({ sessionId: row.session_id, transcriptPath: null });
    }
    // No pid AND no transcript → no signal either way; leave the row alone.
  }

  const sweepOpenSet = canonicalizeOpenSet(
    await openFiles(
      sweepCandidates.map((c) => c.transcriptPath).filter((p): p is string => p !== null),
    ),
  );
  for (const candidate of sweepCandidates) {
    let endedAt: string | undefined;
    if (candidate.transcriptPath) {
      if (sweepOpenSet.has(canonicalPath(candidate.transcriptPath))) continue;
      const mtime = statMtimeMs(candidate.transcriptPath);
      if (mtime !== null && now() - mtime < FRESH_MTIME_MS) continue;
      endedAt = mtime !== null ? new Date(mtime).toISOString() : undefined;
    }
    // Confirmed dead. Capture its open engagement `(id, started_at)` and a token
    // snapshot BEFORE the sync stop+close transaction (Decisions 1-2 / the #1
    // async/sync boundary). `livenessStopSession` compare-and-closes the CAPTURED
    // interval with `liveness_gc` and stops the session ONLY if that close
    // confirms it is still the dead interval — a concurrent reopen leaves both
    // the new interval and the (now live) session untouched.
    const open = getOpenEngagement(candidate.sessionId);
    let snap: TokenSnapshot | null = null;
    try {
      snap = await getCumulativeTokenSource()(candidate.sessionId);
    } catch {
      snap = null;
    }
    if (
      livenessStopSession({
        sessionId: candidate.sessionId,
        engagementId: open?.id ?? null,
        engagementStartedAt: open?.started_at ?? null,
        endedAt,
        tokensAtClose: snap,
      })
    ) {
      summary.swept += 1;
      summary.changed = true;
    }
  }

  writeWatermark(scanStartMs);
  return summary;
}
