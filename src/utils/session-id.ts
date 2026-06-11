/**
 * Resolve the *real* agent session id for the currently-running process.
 *
 * Session identity is an ambient property of the running process — it must
 * never be looked up from shared mutable state (`.syntaur/context.json`'s
 * `sessionId` scalar), because a co-tenant sharing the same workspace clobbers
 * that scalar and a long-lived session would then read the *wrong* id.
 *
 * `resolveOwnSessionId` returns the first non-empty hit across six layers,
 * ordered by trustworthiness:
 *   1. explicit `--session-id` override (`opts.sessionId`)
 *   2. injected env var: CLAUDE_CODE_SESSION_ID / OPENCODE_SESSION_ID / PI_SESSION_ID
 *   3. agent side channel (Cursor nonce → conversation_id; seam, see Phase E)
 *   4. ancestor-pid → runtime marker (`~/.claude/sessions/<pid>.json`,
 *      then `~/.syntaur/runtime/sessions/<pid>.json`), pid-reuse-guarded
 *   5. cwd/mtime transcript scan (last automatic resort; ambiguous under
 *      co-tenancy — same caveat as platforms/codex/scripts/resolve-session.sh)
 *   6. legacy hint (`opts.legacyHint`, i.e. the context.json scalar)
 *
 * Callers that must stay *exact* (the Codex/Claude cleanup paths and the
 * `session resolve-id` subcommand) simply omit `opts.legacyHint`, so they never
 * re-introduce the clobbered scalar. Identity-with-fallback callers
 * (`session save`) pass `legacyHint: ctx?.sessionId`.
 *
 * The function is `async` because layer 5 delegates to `cwd-extractor` file I/O;
 * layers 1, 2, and 4 are effectively synchronous.
 *
 * All process/env/fs touch points are injectable via `ResolverDeps` so unit
 * tests can drive every layer deterministically (mirrors the `LivenessDeps`
 * pattern in `src/dashboard/session-liveness.ts`).
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { captureProcessStartedAt } from './process-info.js';
import { walkClaudeProjects, walkCodexSessions } from '../usage/cwd-extractor.js';

/** Env vars (in precedence order) that agent runtimes inject with the real id. */
export const SESSION_ID_ENV_VARS = [
  'CLAUDE_CODE_SESSION_ID',
  'OPENCODE_SESSION_ID',
  'PI_SESSION_ID',
] as const;

// Resolved ids become filesystem path segments (sessions/<id>/summary.md) and
// URL path segments in the cleanup hooks. Now that ids come from widened sources
// (env vars, ancestor markers, transcript scans), validate them so a malformed
// value can't traverse out of the sessions dir or inject into a URL. Real agent
// ids are UUIDs/ULIDs — alphanumerics, hyphens, underscores — so this is strict
// but never rejects a legitimate id. Invalid candidates are treated as a miss
// and the resolver falls through to the next layer.
const SAFE_SESSION_ID = /^[A-Za-z0-9_-]+$/;
export function isSafeSessionId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && SAFE_SESSION_ID.test(value);
}

/**
 * Shape of a per-process runtime marker file at
 * `<claudeSessionsDir | runtimeSessionsDir>/<pid>.json`. Claude Code writes its
 * native `~/.claude/sessions/<pid>.json` in (a superset of) this shape; the
 * generic `~/.syntaur/runtime/sessions/<pid>.json` is written by a
 * capture-at-birth hook for agents that learn the real id but cannot inject env.
 * Extra fields are tolerated. `sessionId` may be absent on a PENDING marker —
 * written at launch time before the agent has minted its real id (fresh/fork
 * launches); `readRuntimeMarker` rejects those, so pending markers never
 * resolve ids until something backfills them.
 */
export interface RuntimeSessionMarker {
  sessionId?: string;
  agent?: string;
  cwd?: string;
  /** `ps -o lstart=`-style start time, used to guard against pid reuse. */
  procStart?: string;
  writtenAt?: number;
}

/** Injectable dependencies; production callers pass nothing. */
export interface ResolverDeps {
  /** Environment to read layer-2 vars from. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Where the ancestor walk starts. Defaults to `process.ppid` (the agent). */
  startPid?: number;
  /** Home directory for the default marker dirs. Defaults to `os.homedir()`. */
  homeDir?: string;
  /** Returns the parent pid of `pid`, or null. Defaults to `ps -o ppid=`. */
  readPpid?: (pid: number) => number | null;
  /** Returns the start-time of `pid`, or null. Defaults to `captureProcessStartedAt`. */
  pidStartedAt?: (pid: number) => string | null;
  /** Returns a file's mtime in ms, or null. Defaults to `statSync(path).mtimeMs`. */
  statMtimeMs?: (path: string) => number | null;
  /** Claude's native marker dir. Defaults to `<home>/.claude/sessions`. */
  claudeSessionsDir?: string;
  /** Generic agent-neutral marker dir. Defaults to `<home>/.syntaur/runtime/sessions`. */
  runtimeSessionsDir?: string;
  /** Max ancestor-chain depth to walk. Defaults to 12. */
  maxDepth?: number;
}

export interface ResolveSessionOpts {
  /** Explicit override (layer 1). */
  sessionId?: string;
  /** Working directory for the layer-5 transcript scan. */
  cwd?: string;
  /** Legacy `context.json.sessionId` hint (layer 6). Omit to stay exact-only. */
  legacyHint?: string | null;
}

/** Parent pid of `pid` via `ps -o ppid=`, or null. Exported for callers that
 * need the hook-equivalent "shell that owns the agent" fallback pid. */
export function readPpid(pid: number): number | null {
  if (!Number.isFinite(pid) || pid <= 1) return null;
  try {
    const out = execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const parent = Number.parseInt(out.trim(), 10);
    return Number.isInteger(parent) && parent > 0 ? parent : null;
  } catch {
    return null;
  }
}

function defaultStatMtimeMs(path: string): number | null {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

/** Read + validate a runtime marker for `pid` under `dir`. Returns null on any miss. */
export function readRuntimeMarker(pid: number, dir: string): RuntimeSessionMarker | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const path = join(dir, `${pid}.json`);
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (
      parsed &&
      typeof parsed === 'object' &&
      typeof (parsed as Record<string, unknown>).sessionId === 'string' &&
      ((parsed as Record<string, unknown>).sessionId as string).length > 0
    ) {
      return parsed as RuntimeSessionMarker;
    }
    return null;
  } catch {
    return null;
  }
}

/** Write a generic runtime marker for `pid` (used by tests and capture-at-birth). */
export function writeRuntimeMarker(pid: number, marker: RuntimeSessionMarker, dir: string): void {
  const path = join(dir, `${pid}.json`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(marker));
}

/**
 * Layer 3 seam — agent side channels that key on a per-invocation nonce rather
 * than cwd (so they stay co-tenant-safe). Cursor's nonce→conversation_id
 * handshake plugs in here (Phase E). Returns undefined until implemented.
 */
async function resolveSideChannelSessionId(
  _opts: ResolveSessionOpts,
  _deps: ResolverDeps,
): Promise<string | undefined> {
  return undefined;
}

/** Layer 4 — walk the ancestor-pid chain, returning the nearest valid marker's id. */
function resolveFromAncestorMarkers(
  startPid: number,
  claudeSessionsDir: string,
  runtimeSessionsDir: string,
  readPpid: (pid: number) => number | null,
  pidStartedAt: (pid: number) => string | null,
  maxDepth: number,
): string | undefined {
  let pid = startPid;
  for (let depth = 0; depth < maxDepth; depth += 1) {
    if (!Number.isInteger(pid) || pid <= 1) break;
    for (const dir of [claudeSessionsDir, runtimeSessionsDir]) {
      // Read the marker FIRST; only probe `ps` for the pid-reuse guard when a
      // marker actually exists (avoids a `ps` call per level on empty levels).
      const marker = readRuntimeMarker(pid, dir);
      if (!marker) continue;
      if (marker.procStart) {
        // Fail CLOSED: a recorded procStart must be PROVEN to still match. If we
        // can't read the live start time, we can't prove the pid wasn't recycled
        // (a stale marker for a reused pid), so skip rather than trust it.
        const actual = pidStartedAt(pid);
        if (!actual || actual !== marker.procStart) continue;
      }
      if (isSafeSessionId(marker.sessionId)) return marker.sessionId;
    }
    const parent = readPpid(pid);
    if (parent === null) break;
    pid = parent;
  }
  return undefined;
}

/** Layer 5 — scan transcripts for `cwd`, pick the most-recently-written. */
async function resolveFromCwdScan(
  cwd: string,
  statMtimeMs: (path: string) => number | null,
): Promise<string | undefined> {
  const candidates: Array<{ sessionId: string; mtime: number }> = [];
  for await (const meta of walkClaudeProjects()) {
    if (meta.cwd === cwd && isSafeSessionId(meta.sessionId)) {
      candidates.push({ sessionId: meta.sessionId, mtime: statMtimeMs(meta.path) ?? 0 });
    }
  }
  for await (const meta of walkCodexSessions()) {
    if (meta.cwd === cwd && isSafeSessionId(meta.sessionId)) {
      candidates.push({ sessionId: meta.sessionId, mtime: statMtimeMs(meta.path) ?? 0 });
    }
  }
  if (candidates.length === 0) return undefined;
  // Deterministic: newest mtime wins; ties broken by sessionId descending.
  candidates.sort((a, b) => b.mtime - a.mtime || (a.sessionId < b.sessionId ? 1 : a.sessionId > b.sessionId ? -1 : 0));
  return candidates[0].sessionId;
}

export async function resolveOwnSessionId(
  opts: ResolveSessionOpts = {},
  deps: ResolverDeps = {},
): Promise<string | undefined> {
  // Layer 1 — explicit override.
  if (isSafeSessionId(opts.sessionId)) return opts.sessionId;

  // Layer 2 — injected env var (clobber-proof, per-process).
  const env = deps.env ?? process.env;
  for (const key of SESSION_ID_ENV_VARS) {
    const value = env[key];
    if (isSafeSessionId(value)) return value;
  }

  // Layer 3 — agent side channel (seam).
  const sideChannel = await resolveSideChannelSessionId(opts, deps);
  if (sideChannel) return sideChannel;

  // Layer 4 — ancestor-pid runtime marker.
  const home = deps.homeDir ?? homedir();
  const claudeSessionsDir = deps.claudeSessionsDir ?? join(home, '.claude', 'sessions');
  const runtimeSessionsDir = deps.runtimeSessionsDir ?? join(home, '.syntaur', 'runtime', 'sessions');
  const startPid = deps.startPid ?? process.ppid;
  const fromMarker = resolveFromAncestorMarkers(
    startPid,
    claudeSessionsDir,
    runtimeSessionsDir,
    deps.readPpid ?? readPpid,
    deps.pidStartedAt ?? captureProcessStartedAt,
    deps.maxDepth ?? 12,
  );
  if (fromMarker) return fromMarker;

  // Layer 5 — cwd/mtime transcript scan (last automatic resort).
  if (opts.cwd) {
    const fromScan = await resolveFromCwdScan(opts.cwd, deps.statMtimeMs ?? defaultStatMtimeMs);
    if (fromScan) return fromScan;
  }

  // Layer 6 — legacy context.json hint (only when the caller opts in).
  if (isSafeSessionId(opts.legacyHint)) return opts.legacyHint;

  return undefined;
}
