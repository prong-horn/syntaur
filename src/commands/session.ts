import { Command } from 'commander';
import { readFile, readdir, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileExists, writeFileForce } from '../utils/fs.js';
import { assignmentsDir, expandHome } from '../utils/paths.js';
import { readConfig, type SessionAutoTrack } from '../utils/config.js';
import { nowTimestamp } from '../utils/timestamp.js';
import { assertMayMutate, isSafeSessionId, readPpid, resolveOwnSessionId } from '../utils/session-id.js';
import { captureProcessStartedAt } from '../utils/process-info.js';
import { captureHeadSha } from '../utils/git-worktree.js';
import { isExistingDir } from '../launch/cwd.js';
import { initSessionDb } from '../dashboard/session-db.js';
import { appendSession, updateSessionStatus } from '../dashboard/agent-sessions.js';
import type { AgentSessionStatus } from '../dashboard/types.js';
import { resolveAssignmentTarget } from '../utils/assignment-target.js';
import {
  resolveEngagementBinding,
  resolveSessionEngagement,
  type EngagementBinding,
} from '../utils/engagement-binding.js';
import { getOpenEngagement } from '../db/engagement-db.js';
import { extractFrontmatter, getField } from '../dashboard/parser.js';

interface ContextFile {
  sessionId?: string;
  transcriptPath?: string | null;
  latestSessionSummaryPath?: string | null;
  projectSlug?: string;
  assignmentSlug?: string;
  projectDir?: string;
  assignmentDir?: string;
  workspaceRoot?: string;
  title?: string;
  branch?: string;
  // Bundle-scoped fields tolerated for forward-compat; this reader only
  // surfaces assignment-scoped fields.
  bundleId?: string;
  bundleSlug?: string;
  bundleScope?: string;
  bundleScopeId?: string;
  todoIds?: string[];
  planDir?: string;
  worktreePath?: string;
  repository?: string;
  boundAt?: string;
}

async function readContext(cwd: string): Promise<ContextFile | null> {
  const path = resolve(cwd, '.syntaur', 'context.json');
  if (!(await fileExists(path))) return null;
  try {
    const raw = await readFile(path, 'utf-8');
    return JSON.parse(raw) as ContextFile;
  } catch {
    return null;
  }
}

async function findLatestSessionSummary(
  assignmentDir: string,
): Promise<{ sessionId: string; path: string; mtime: Date } | null> {
  const sessionsRoot = resolve(assignmentDir, 'sessions');
  if (!(await fileExists(sessionsRoot))) return null;
  const entries = await readdir(sessionsRoot, { withFileTypes: true });
  let best: { sessionId: string; path: string; mtime: Date } | null = null;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const summaryPath = resolve(sessionsRoot, entry.name, 'summary.md');
    if (!(await fileExists(summaryPath))) continue;
    const st = await stat(summaryPath);
    if (best === null || st.mtime.getTime() > best.mtime.getTime()) {
      best = { sessionId: entry.name, path: summaryPath, mtime: st.mtime };
    }
  }
  return best;
}

async function findOpenHandoff(assignmentDir: string): Promise<string | null> {
  // The Syntaur protocol uses a single root handoff.md per assignment (managed
  // by complete-assignment). Surface it whenever it exists and has any body
  // content beyond the placeholder so the resuming agent reads the latest
  // outbound baton. We treat any non-empty handoff.md as a signal — there is
  // currently no per-handoff `status: open` flag in the canonical schema.
  const handoffPath = resolve(assignmentDir, 'handoff.md');
  if (!(await fileExists(handoffPath))) return null;
  const content = await readFile(handoffPath, 'utf-8');
  const body = content.replace(/^---[\s\S]*?\n---\n?/, '').trim();
  if (body.length === 0) return null;
  // Skip the placeholder body that create-assignment scaffolds.
  if (/^<!--[\s\S]*-->$/.test(body)) return null;
  return handoffPath;
}

interface ResumeOptions {
  json?: boolean;
}

/** The active assignment resolved from the session's OPEN engagement. */
interface ResolvedAssignmentView {
  assignmentDir: string;
  projectSlug: string | null;
  assignmentSlug: string | null;
  id: string;
  standalone: boolean;
  title: string | null;
}

interface ResumeOutput {
  ok: boolean;
  /** Workspace markers (branch/workspaceRoot) read from .syntaur/context.json. */
  context: ContextFile | null;
  /** The active assignment, resolved from the session's OPEN engagement. */
  assignment: ResolvedAssignmentView | null;
  latestSession: { sessionId: string; path: string } | null;
  openHandoff: string | null;
  warnings: string[];
}

/** Read the `title:` frontmatter field from a resolved assignment's assignment.md. */
async function readAssignmentTitle(assignmentDir: string): Promise<string | null> {
  const path = resolve(assignmentDir, 'assignment.md');
  if (!(await fileExists(path))) return null;
  try {
    const content = await readFile(path, 'utf-8');
    const [fm] = extractFrontmatter(content);
    return getField(fm, 'title');
  } catch {
    return null;
  }
}

async function buildResumeOutput(cwd: string): Promise<ResumeOutput> {
  const warnings: string[] = [];
  // context.json is still read — but ONLY for workspace markers (branch /
  // workspaceRoot) to display. The active assignment is resolved from the
  // session's OPEN engagement, NOT the demoted context.json assignment scalar.
  const context = await readContext(cwd);

  // Resolve the active assignment from the session's open engagement. READ-ONLY:
  // no assertMayMutate. initSessionDb is idempotent — the engagement edge lives
  // in the sessions DB, which must be open before resolveSessionEngagement reads.
  initSessionDb();
  const se = await resolveSessionEngagement(cwd);
  if (!se?.open) {
    return {
      ok: false,
      context,
      assignment: null,
      latestSession: null,
      openHandoff: null,
      warnings: [
        'No active assignment for this session. Run /grab-assignment to bind one, then resume.',
      ],
    };
  }

  let assignment: ResolvedAssignmentView;
  try {
    const target = await resolveAssignmentTarget(undefined, {
      cwd,
      resolveEngagement: async () => se.open,
    });
    assignment = {
      assignmentDir: target.assignmentDir,
      projectSlug: target.projectSlug,
      assignmentSlug: target.assignmentSlug,
      id: target.id,
      standalone: target.standalone,
      title: await readAssignmentTitle(target.assignmentDir),
    };
  } catch (error) {
    return {
      ok: false,
      context,
      assignment: null,
      latestSession: null,
      openHandoff: null,
      warnings: [error instanceof Error ? error.message : String(error)],
    };
  }

  const latestSession = await findLatestSessionSummary(assignment.assignmentDir);
  if (!latestSession) {
    warnings.push(
      `No session summary found under ${assignment.assignmentDir}/sessions/. Run /save-session-summary in a prior session to leave a resume baton.`,
    );
  }
  const openHandoff = await findOpenHandoff(assignment.assignmentDir);

  return {
    ok: true,
    context,
    assignment,
    latestSession: latestSession
      ? { sessionId: latestSession.sessionId, path: latestSession.path }
      : null,
    openHandoff,
    warnings,
  };
}

function renderHumanOutput(out: ResumeOutput): string {
  const lines: string[] = [];
  if (!out.ok) {
    lines.push('Cannot resume:');
    for (const w of out.warnings) lines.push(`  - ${w}`);
    return lines.join('\n');
  }
  // Assignment dir/slugs come from the RESOLVED engagement target; branch and
  // workspace-root are workspace markers still read from context.json.
  const asg = out.assignment!;
  const ctx = out.context;
  lines.push('Resuming Syntaur session');
  lines.push('');
  lines.push(`  Project:        ${asg.projectSlug ?? '(standalone)'}`);
  lines.push(`  Assignment:     ${asg.assignmentSlug ?? asg.id}`);
  if (asg.title) lines.push(`  Title:          ${asg.title}`);
  if (ctx?.branch) lines.push(`  Branch:         ${ctx.branch}`);
  if (ctx?.workspaceRoot) lines.push(`  Workspace root: ${ctx.workspaceRoot}`);
  lines.push(`  Assignment dir: ${asg.assignmentDir}`);
  lines.push('');
  if (out.latestSession) {
    lines.push(`Latest session summary: ${out.latestSession.path}`);
    lines.push(`Read it next to load What’s Next + Open Questions.`);
  } else {
    lines.push('No prior session summary on disk.');
  }
  if (out.openHandoff) {
    lines.push('');
    lines.push(`Open handoff: ${out.openHandoff}`);
    lines.push('Read it before continuing — there is an outstanding baton.');
  }
  if (out.warnings.length > 0) {
    lines.push('');
    lines.push('Warnings:');
    for (const w of out.warnings) lines.push(`  - ${w}`);
  }
  return lines.join('\n');
}

export async function runSessionResume(
  options: ResumeOptions,
  cwd: string = process.cwd(),
): Promise<ResumeOutput> {
  const out = await buildResumeOutput(cwd);
  if (options.json) {
    console.log(JSON.stringify(out, null, 2));
  } else {
    console.log(renderHumanOutput(out));
  }
  return out;
}

// --- session boundary (read-only; the write-boundary enforcers' resolution source) ---

export interface SessionBoundaryOptions {
  sessionId?: string;
  cwd?: string;
  json?: boolean;
}

/** The write-boundary the enforcer hooks allow, resolved from the OPEN engagement. */
export interface SessionBoundaryResult {
  /** The active assignment dir (engagement-resolved), or null when none resolves. */
  assignmentDir: string | null;
  /** The project root (parent of `assignments/<slug>`), or null for standalone / none. */
  projectDir: string | null;
  /** Workspace marker read from `.syntaur/context.json`, or null. */
  workspaceRoot: string | null;
}

/**
 * Resolve the write boundary for the calling session from its OPEN engagement.
 * The write-boundary enforcer hooks (claude-code / codex / pi) call this to learn
 * the allowlist — `context.json`'s assignment scalars were demoted, so the hooks
 * can no longer read `assignmentDir`/`projectDir` from disk.
 *
 * Resolution:
 *  - session id: explicit `options.sessionId` (EXPLICIT), else self-resolve from cwd.
 *  - open engagement → reconstruct `assignmentDir` via `resolveAssignmentTarget`.
 *  - `projectDir` = the project root (parent of `assignments/<slug>`,
 *    i.e. `resolve(assignmentDir, '..', '..')`) for project-nested; null for standalone.
 *  - `workspaceRoot` is read from `<cwd>/.syntaur/context.json` (a workspace marker).
 *
 * NEVER throws to the caller: on ANY failure it returns all-null. Read-only and
 * FAST — no summary/handoff scanning. The hook treats missing fields as
 * "enforce workspace-only".
 */
export async function runSessionBoundary(
  options: SessionBoundaryOptions,
): Promise<SessionBoundaryResult> {
  const cwd = options.cwd ?? process.cwd();
  const empty: SessionBoundaryResult = {
    assignmentDir: null,
    projectDir: null,
    workspaceRoot: null,
  };

  // Workspace marker is independent of the engagement — read it best-effort so we
  // can still enforce workspace-only when no assignment resolves.
  let workspaceRoot: string | null = null;
  try {
    const ctx = await readContext(cwd);
    if (ctx?.workspaceRoot) workspaceRoot = expandHome(ctx.workspaceRoot);
  } catch {
    /* leave null */
  }

  try {
    const resolved = await resolveOwnSessionId({ sessionId: options.sessionId, cwd });
    if (!resolved) return { ...empty, workspaceRoot };

    initSessionDb(); // idempotent — the engagement edge lives in the sessions DB
    const row = getOpenEngagement(resolved.id);
    if (!row) return { ...empty, workspaceRoot };

    const binding: EngagementBinding = {
      assignmentId: row.assignment_id,
      projectSlug: row.project_slug,
      assignmentSlug: row.assignment_slug,
      stage: row.stage,
    };
    const target = await resolveAssignmentTarget(undefined, {
      cwd,
      resolveEngagement: async () => binding,
    });
    const assignmentDir = target.assignmentDir;
    // Project root = parent of `assignments/<slug>`: resolve(dir,'..','..').
    // Standalone assignments are not project-nested → no project resources dir.
    const projectDir = target.standalone ? null : resolve(assignmentDir, '..', '..');
    return { assignmentDir, projectDir, workspaceRoot };
  } catch {
    return { ...empty, workspaceRoot };
  }
}

export interface SessionSaveOptions {
  sessionId?: string;
  fromFile?: string;
  assignment?: string;
  project?: string;
}

async function resolveSaveTarget(
  options: SessionSaveOptions,
  cwd: string,
): Promise<{ assignmentDir: string; slug: string; sessionId: string }> {
  let assignmentDir: string;
  let slug: string;
  const ctx = await readContext(cwd);

  if (options.assignment) {
    assignmentDir = options.project
      ? resolve((await readConfig()).defaultProjectDir, options.project, 'assignments', options.assignment)
      : resolve(assignmentsDir(), options.assignment);
    slug = options.assignment;
  } else {
    // No explicit target → resolve from the session's OPEN engagement. The
    // demoted context.json assignment scalars (assignmentDir/assignmentSlug)
    // are NO LONGER a resolution source — context.json is a workspace marker
    // only. (context.json's sessionId is still read below, purely as the
    // last-resort legacy session-id hint.)
    initSessionDb(); // idempotent; the engagement edge lives in the sessions DB
    const target = await resolveAssignmentTarget(undefined, {
      project: options.project,
      cwd,
      resolveEngagement: () => resolveEngagementBinding(cwd),
    });
    assignmentDir = target.assignmentDir;
    slug = target.assignmentSlug;
  }

  // Resolve the caller's OWN session id from the process, not the shared
  // context.json scalar (a co-tenant clobbers the scalar). The context scalar
  // is passed only as the last-resort legacy hint.
  const resolved = await resolveOwnSessionId({
    sessionId: options.sessionId,
    cwd,
    legacyHint: ctx?.sessionId,
  });
  if (!resolved) {
    throw new Error(
      'Session not tracked. Pass --session-id <id>, or run `syntaur track-session ...` first so context.json carries a real session id.',
    );
  }
  assertMayMutate(resolved, { hasSelector: Boolean(options.assignment) });
  return { assignmentDir, slug, sessionId: resolved.id };
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf-8');
}

const SESSION_SUMMARY_SKELETON = `# Session Summary

## Snapshot

<One paragraph: what the assignment is, where work stands, what is load-bearing on resume.>

## What Was Done

-

## What's Next

-

## Open Questions

None.

## Load-Bearing Context

-
`;

/** Extract the existing \`created\` frontmatter timestamp, or null. */
function extractCreated(content: string): string | null {
  const m = content.match(/^created:\s*"?([^"\n]+)"?\s*$/m);
  return m ? m[1] : null;
}

export async function runSessionSave(
  options: SessionSaveOptions,
  cwd: string = process.cwd(),
  body?: string,
): Promise<string> {
  const { assignmentDir, slug, sessionId } = await resolveSaveTarget(options, cwd);
  if (!(await fileExists(resolve(assignmentDir, 'assignment.md')))) {
    throw new Error(`No assignment found at ${assignmentDir} (missing assignment.md).`);
  }
  const sessionDir = resolve(assignmentDir, 'sessions', sessionId);
  const summaryPath = resolve(sessionDir, 'summary.md');
  const now = nowTimestamp();

  let created = now;
  if (await fileExists(summaryPath)) {
    const existing = await readFile(summaryPath, 'utf-8');
    created = extractCreated(existing) ?? now;
  }

  let sectionBody = body;
  if (sectionBody === undefined) {
    if (options.fromFile) {
      sectionBody = await readFile(resolve(cwd, options.fromFile), 'utf-8');
    } else {
      sectionBody = await readStdin();
    }
  }
  const trimmed = (sectionBody ?? '').trim();
  const content = `---
assignment: ${slug}
sessionId: ${sessionId}
created: "${created}"
updated: "${now}"
---

${trimmed.length > 0 ? trimmed : SESSION_SUMMARY_SKELETON.trim()}
`;

  // writeFileForce ensures sessions/<id>/ exists and writes atomically.
  await writeFileForce(summaryPath, content);
  return summaryPath;
}

// --- session register / stop (hook-driven, zero-token, DB-direct) ---

interface HookPayload {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
}

function parseHookPayload(rawStdin: string): HookPayload | null {
  try {
    const parsed: unknown = JSON.parse(rawStdin);
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed as HookPayload;
  } catch {
    return null;
  }
}

export interface SessionRegisterOptions {
  fromHook?: boolean;
  agent?: string;
  pid?: string;
}

/** Injectable seams for tests; production callers pass nothing. */
export interface SessionRegisterDeps {
  /** Override the configured `session.autoTrack` (skips readConfig). */
  autoTrack?: SessionAutoTrack;
  /** Owning pid when --pid is absent. Defaults to readPpid(process.ppid) —
   * the shell that owns the agent, matching the bash hook's `ps -o ppid= -p $$`. */
  fallbackPid?: () => number | null;
  pidStartedAt?: (pid: number) => string | null;
  headSha?: (cwd: string) => Promise<string | null>;
  now?: () => string;
}

export interface SessionRegisterResult {
  merged: boolean;
  registered: boolean;
  sessionId: string | null;
}

/**
 * Deterministic SessionStart registration (criterion: no dashboard, no LLM).
 * Parses the hook's stdin payload, merges session fields into an EXISTING
 * `.syntaur/context.json` (never creates one), and upserts the session row
 * directly into the sessions DB. Standalone sessions (no context.json)
 * register as unlinked rows. Never throws — the CLI action exits 0 always.
 */
export async function runSessionRegister(
  rawStdin: string,
  options: SessionRegisterOptions = {},
  deps: SessionRegisterDeps = {},
): Promise<SessionRegisterResult> {
  const result: SessionRegisterResult = { merged: false, registered: false, sessionId: null };

  const payload = parseHookPayload(rawStdin);
  if (!payload) return result;
  const sessionId = payload.session_id;
  const cwd = payload.cwd;
  if (!isSafeSessionId(sessionId) || !cwd) return result;
  result.sessionId = sessionId;
  const transcriptPath = payload.transcript_path ?? '';

  // --- (1) Merge session fields into an EXISTING context.json. Mirrors the
  // bash merge this replaces: always replace sessionId and transcriptPath
  // together (null when the incoming transcript_path is empty, so a new
  // session never inherits a stale path), and resolve the newest-mtime
  // session summary for mid-assignment continuity.
  const contextPath = resolve(cwd, '.syntaur', 'context.json');
  const hasContextFile = await fileExists(contextPath);
  const ctx = hasContextFile ? await readContext(cwd) : null;
  if (ctx) {
    try {
      const assignmentDir = ctx.assignmentDir ? expandHome(ctx.assignmentDir) : null;
      const latest = assignmentDir ? await findLatestSessionSummary(assignmentDir) : null;
      const merged: ContextFile = {
        ...ctx,
        sessionId,
        transcriptPath: transcriptPath.length > 0 ? transcriptPath : null,
        latestSessionSummaryPath: latest?.path ?? null,
      };
      await writeFileForce(contextPath, `${JSON.stringify(merged, null, 2)}\n`);
      result.merged = true;
    } catch {
      // Leave context.json untouched on any failure — same as the bash `|| rm -f $TMP`.
    }
  }

  // --- (2) DB registration, gated on session.autoTrack.
  const autoTrack = deps.autoTrack ?? (await readConfig()).session.autoTrack;
  if (autoTrack === 'off') return result;
  if (autoTrack === 'workspaces-only' && !hasContextFile) return result;

  initSessionDb();

  const optPid = options.pid !== undefined ? Number.parseInt(String(options.pid), 10) : NaN;
  const pid = Number.isInteger(optPid) && optPid > 0
    ? optPid
    : (deps.fallbackPid ?? (() => readPpid(process.ppid)))();
  const pidStartedAt = pid !== null ? (deps.pidStartedAt ?? captureProcessStartedAt)(pid) : null;
  const originalHeadSha = isExistingDir(cwd)
    ? await (deps.headSha ?? captureHeadSha)(cwd)
    : null;

  await appendSession(
    '',
    {
      // UNATTRIBUTED on register. The SessionStart hook no longer auto-binds the
      // assignment from the cwd context.json scalar — that cwd-scalar auto-bind is
      // the multi-assignment-in-one-worktree clobber being eliminated. A session
      // binds its assignment explicitly via `syntaur track-session --project
      // --assignment` (the grab flow); on a resume/revive `appendSession` recovers
      // the binding from the session's OWN latest engagement (reviveStopped below).
      projectSlug: null,
      assignmentSlug: null,
      agent: options.agent || 'claude',
      sessionId,
      started: deps.now?.() ?? new Date().toISOString(),
      status: 'active' as AgentSessionStatus,
      path: cwd,
      description: null,
      transcriptPath: transcriptPath.length > 0 ? transcriptPath : null,
      pid,
      pidStartedAt,
      originalHeadSha,
    },
    // A SessionStart firing for this exact id IS live-process evidence — e.g.
    // `claude --resume` of a previously stopped session must flip it back to
    // active. `completed` still sticks (appendSession enforces).
    { reviveStopped: true },
  );
  result.registered = true;
  return result;
}

export interface SessionStopResult {
  stopped: boolean;
  sessionId: string | null;
}

/**
 * Deterministic SessionEnd handling: resolve the ENDING session's id (stdin
 * `.session_id` first; the shared context.json scalar only as a last-resort
 * fallback — a co-tenant can clobber it) and mark the row stopped with a
 * direct DB write. Never throws.
 */
export async function runSessionStop(rawStdin: string): Promise<SessionStopResult> {
  const result: SessionStopResult = { stopped: false, sessionId: null };

  const payload = parseHookPayload(rawStdin);
  if (!payload) return result;

  let sessionId = isSafeSessionId(payload.session_id) ? payload.session_id : null;
  if (!sessionId && payload.cwd) {
    const ctx = await readContext(payload.cwd);
    if (isSafeSessionId(ctx?.sessionId)) sessionId = ctx!.sessionId!;
  }
  if (!sessionId) return result;
  result.sessionId = sessionId;

  initSessionDb();
  result.stopped = await updateSessionStatus('', sessionId, 'stopped');
  return result;
}

export const sessionCommand = new Command('session')
  .description('Manage agent sessions for the active assignment');

sessionCommand
  .command('register')
  .description(
    'Register the calling agent session in the sessions DB (SessionStart hook entry point). Reads the hook JSON payload from stdin; merges session fields into an existing .syntaur/context.json; always exits 0.',
  )
  .option('--from-hook', 'Read the SessionStart JSON payload from stdin')
  .option('--agent <name>', 'Agent name for the session row', 'claude')
  .option('--pid <pid>', 'Owning process pid for liveness checks (defaults to the grandparent pid)')
  .action(async (options: SessionRegisterOptions) => {
    if (!options.fromHook) {
      console.error('session register currently requires --from-hook (stdin JSON payload).');
      process.exit(1);
    }
    // Hook path: NEVER fail — a broken registration must not break the agent session.
    try {
      await runSessionRegister(await readStdin(), options);
    } catch {
      /* always exit 0 */
    }
  });

sessionCommand
  .command('scan')
  .description(
    'Reconcile the sessions DB against on-disk agent transcripts: upsert every discovered session, link workspaces, revive on live-process evidence, sweep stale active rows.',
  )
  .option('--full', 'Ignore the incremental mtime watermark and rescan everything')
  .option('--json', 'Emit the scan summary as JSON')
  .action(async (options: { full?: boolean; json?: boolean }) => {
    try {
      const { scanSessions } = await import('../sessions/scanner.js');
      initSessionDb();
      const summary = await scanSessions({ full: options.full });
      if (options.json) {
        console.log(JSON.stringify(summary));
      } else {
        console.log(
          `Scan complete — discovered ${summary.discovered}, inserted ${summary.inserted}, revived ${summary.revived}, swept ${summary.swept}, skipped ${summary.skipped}.`,
        );
      }
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

sessionCommand
  .command('scan-install')
  .description(
    'Install the macOS LaunchAgent that runs `session scan` on an interval (the liveness GC for Codex + dashboard-off).',
  )
  .option('--interval <seconds>', 'scan interval in seconds (default 300)')
  .action(async (options: { interval?: string }) => {
    try {
      const { installSessionScanAgent } = await import('../schedules/launchd.js');
      const res = installSessionScanAgent({
        intervalSeconds: options.interval ? Number.parseInt(options.interval, 10) : undefined,
      });
      console.log(`Installed ${res.label} (every ${res.intervalSeconds}s) → ${res.plistPath}`);
      console.log(
        'Note: fires only while this Mac is awake + logged in. Non-macOS: add a cron line running `syntaur session scan`.',
      );
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

sessionCommand
  .command('scan-uninstall')
  .description('Uninstall the macOS LaunchAgent that runs `session scan`.')
  .action(async () => {
    try {
      const { uninstallSessionScanAgent } = await import('../schedules/launchd.js');
      const res = uninstallSessionScanAgent();
      console.log(`Uninstalled ${res.label} (removed ${res.plistPath}).`);
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

sessionCommand
  .command('stop')
  .description(
    'Mark the calling agent session stopped in the sessions DB (SessionEnd hook entry point). Reads the hook JSON payload from stdin; always exits 0.',
  )
  .option('--from-hook', 'Read the SessionEnd JSON payload from stdin')
  .action(async (options: { fromHook?: boolean }) => {
    if (!options.fromHook) {
      console.error('session stop currently requires --from-hook (stdin JSON payload).');
      process.exit(1);
    }
    try {
      await runSessionStop(await readStdin());
    } catch {
      /* always exit 0 */
    }
  });

sessionCommand
  .command('resume')
  .description(
    'Re-orient a fresh session: print active assignment context, latest saved session summary, and any open handoff. Idempotent — does not mutate state.',
  )
  .option('--json', 'Emit machine-readable JSON instead of human-readable text')
  .action(async (options: ResumeOptions) => {
    try {
      const out = await runSessionResume(options);
      if (!out.ok) process.exit(1);
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

sessionCommand
  .command('save')
  .description("Write the session's continuity summary to sessions/<sessionId>/summary.md")
  .option('--session-id <id>', 'Session id (defaults to the resolved session: env / process tree, falling back to the .syntaur/context.json hint)')
  .option('--from-file <path>', 'Read the summary body from a file (else stdin; else a skeleton)')
  .option('--assignment <slug>', 'Assignment slug (UUID for standalone). Defaults to .syntaur/context.json')
  .option('--project <slug>', 'Project slug. Required with --assignment for a project-nested assignment')
  .action(async (options: SessionSaveOptions) => {
    try {
      const path = await runSessionSave(options);
      console.log(`Saved session summary to ${path}`);
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

sessionCommand
  .command('resolve-id')
  .description(
    "Print the caller's own real session id, resolved from the process (env / process tree / transcript). Exits 1 if none can be resolved. Deliberately does NOT read the context.json scalar — for hooks that must attribute the exact ending session.",
  )
  .option('--cwd <path>', 'Working directory for the transcript-scan fallback', process.cwd())
  .action(async (options: { cwd?: string }) => {
    try {
      const resolved = await resolveOwnSessionId({ cwd: options.cwd ?? process.cwd() });
      if (!resolved) process.exit(1);
      console.log(resolved.id);
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

sessionCommand
  .command('boundary')
  .description(
    "Resolve the calling session's write boundary from its OPEN engagement (for the write-boundary enforcer hooks). Prints { assignmentDir, projectDir, workspaceRoot } as JSON. NEVER throws — prints {} and exits 0 on any failure.",
  )
  .option('--session-id <id>', "The calling session's id (else self-resolved from the process / cwd)")
  .option('--cwd <path>', 'Working directory holding .syntaur/context.json', process.cwd())
  .option('--json', 'Emit the boundary as JSON (default and only format)')
  .action(async (options: SessionBoundaryOptions) => {
    // Read-only and fail-safe: on ANY failure emit `{}` so the hook falls back
    // to workspace-only enforcement. Always exit 0.
    try {
      const result = await runSessionBoundary({
        sessionId: options.sessionId,
        cwd: options.cwd ?? process.cwd(),
      });
      console.log(JSON.stringify(result));
    } catch {
      console.log('{}');
    }
  });

export const _internal = {
  buildResumeOutput,
  findLatestSessionSummary,
  findOpenHandoff,
  readContext,
};
