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

interface ResumeOutput {
  ok: boolean;
  context: ContextFile | null;
  latestSession: { sessionId: string; path: string } | null;
  openHandoff: string | null;
  warnings: string[];
}

async function buildResumeOutput(cwd: string): Promise<ResumeOutput> {
  const warnings: string[] = [];
  const context = await readContext(cwd);
  if (!context) {
    return {
      ok: false,
      context: null,
      latestSession: null,
      openHandoff: null,
      warnings: [
        'No .syntaur/context.json in current directory. Run grab-assignment first.',
      ],
    };
  }
  if (!context.assignmentDir) {
    return {
      ok: false,
      context,
      latestSession: null,
      openHandoff: null,
      warnings: [
        'context.json present but no assignmentDir field — only a session record exists. Nothing to resume.',
      ],
    };
  }

  const latestSession = await findLatestSessionSummary(context.assignmentDir);
  if (!latestSession) {
    warnings.push(
      `No session summary found under ${context.assignmentDir}/sessions/. Run /save-session-summary in a prior session to leave a resume baton.`,
    );
  }
  const openHandoff = await findOpenHandoff(context.assignmentDir);

  return {
    ok: true,
    context,
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
  const ctx = out.context!;
  lines.push('Resuming Syntaur session');
  lines.push('');
  lines.push(`  Project:        ${ctx.projectSlug ?? '(standalone)'}`);
  lines.push(`  Assignment:     ${ctx.assignmentSlug ?? '(unknown)'}`);
  if (ctx.title) lines.push(`  Title:          ${ctx.title}`);
  if (ctx.branch) lines.push(`  Branch:         ${ctx.branch}`);
  if (ctx.workspaceRoot) lines.push(`  Workspace root: ${ctx.workspaceRoot}`);
  lines.push(`  Assignment dir: ${ctx.assignmentDir}`);
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
    if (!ctx?.assignmentDir) {
      throw new Error(
        'No active assignment. Pass --assignment <slug> [--project <slug>] or run from a workspace with .syntaur/context.json.',
      );
    }
    assignmentDir = ctx.assignmentDir;
    slug = ctx.assignmentSlug ?? '';
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
      projectSlug: ctx?.projectSlug || null,
      assignmentSlug: ctx?.assignmentSlug || null,
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

export const _internal = {
  buildResumeOutput,
  findLatestSessionSummary,
  findOpenHandoff,
  readContext,
};
