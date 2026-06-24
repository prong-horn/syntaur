import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { expandHome } from '../utils/paths.js';
import { fileExists } from '../utils/fs.js';
import { readConfig } from '../utils/config.js';
import { derivePathFromTranscript } from '../utils/transcript.js';
import { captureProcessStartedAt } from '../utils/process-info.js';
import { captureHeadSha } from '../utils/git-worktree.js';
import { readPpid, resolveOwnSessionId, isSafeSessionId, assertMayMutate } from '../utils/session-id.js';
import type { ResolvedSession } from '../utils/session-id.js';
import { isExistingDir } from '../launch/cwd.js';
import { initSessionDb } from '../dashboard/session-db.js';
import { appendSession } from '../dashboard/agent-sessions.js';
import type { AgentSessionStatus } from '../dashboard/types.js';

export interface TrackSessionOptions {
  project?: string;
  assignment?: string;
  agent: string;
  sessionId?: string;
  path?: string;
  dir?: string;
  description?: string;
  transcriptPath?: string;
  pid?: number;
}

/** Injectable seams for tests; production callers pass nothing. */
export interface TrackSessionDeps {
  resolveSessionId?: typeof resolveOwnSessionId;
  fallbackPid?: () => number | null;
}

export async function trackSessionCommand(
  options: TrackSessionOptions,
  deps: TrackSessionDeps = {},
): Promise<void> {
  if (!options.agent) {
    throw new Error('--agent <name> is required.');
  }

  // Self-resolve the calling session's id when not passed explicitly: env →
  // process-tree markers → transcript scan, with the cwd context.json scalar
  // only as the last-resort legacy hint. Never synthesized.
  let resolved: ResolvedSession | undefined;
  if (options.sessionId) {
    if (!isSafeSessionId(options.sessionId)) {
      throw new Error(
        'Could not resolve a session id. Pass --session-id <id> with the real agent-generated session id — do not synthesize one.',
      );
    }
    resolved = { id: options.sessionId, provenance: 'EXPLICIT' };
  } else {
    const cwd = process.cwd();
    let legacyHint: string | undefined;
    try {
      const raw = await readFile(resolve(cwd, '.syntaur', 'context.json'), 'utf-8');
      const parsed = JSON.parse(raw) as { sessionId?: string };
      if (typeof parsed.sessionId === 'string') legacyHint = parsed.sessionId;
    } catch {
      // No context.json — fine; the resolver has five other layers.
    }
    resolved = await (deps.resolveSessionId ?? resolveOwnSessionId)({ cwd, legacyHint });
  }
  if (!resolved) {
    throw new Error(
      'Could not resolve a session id. Pass --session-id <id> with the real agent-generated session id — do not synthesize one.',
    );
  }
  const sessionId = resolved.id;

  if (options.project) {
    const config = await readConfig();
    const baseDir = options.dir
      ? expandHome(options.dir)
      : config.defaultProjectDir;
    const projectDir = resolve(baseDir, options.project);

    if (!(await fileExists(projectDir))) {
      throw new Error(
        `Project "${options.project}" not found at ${projectDir}.`,
      );
    }
  }

  initSessionDb();

  // Prefer the launch cwd recorded in the transcript itself — that's the
  // directory Claude Code uses to file the transcript, and the only one from
  // which `claude --resume <id>` can find it. Falls through to the explicit
  // --path or the registering process's cwd when no transcript is supplied
  // (or it isn't readable yet).
  const derivedPath = await derivePathFromTranscript(options.transcriptPath);
  const recordedPath = derivedPath ?? options.path ?? process.cwd();

  // Default the owning pid to the grandparent — the shell that owns the agent
  // (this CLI's parent is the agent/skill shell) — matching the hook's
  // `ps -o ppid= -p $$`, so the one-line skill call loses no liveness data.
  const pid = options.pid ?? (deps.fallbackPid ?? (() => readPpid(process.ppid)))();
  const pidStartedAt = pid !== null ? captureProcessStartedAt(pid) : null;

  // Best-effort capture of the worktree's HEAD sha so a later recreate of a
  // deleted worktree can be exact. Never blocks registration on git.
  const originalHeadSha = isExistingDir(recordedPath)
    ? await captureHeadSha(recordedPath)
    : null;

  assertMayMutate(resolved, { hasSelector: Boolean(options.assignment) });

  await appendSession('', {
    projectSlug: options.project || null,
    assignmentSlug: options.assignment || null,
    agent: options.agent,
    sessionId,
    started: new Date().toISOString(),
    status: 'active' as AgentSessionStatus,
    path: recordedPath,
    description: options.description || null,
    transcriptPath: options.transcriptPath ?? null,
    pid,
    pidStartedAt,
    originalHeadSha,
  });

  if (options.project && options.assignment) {
    console.log(
      `Registered agent session ${sessionId} for ${options.assignment} in ${options.project}.`,
    );
  } else {
    console.log(`Registered standalone agent session ${sessionId}.`);
  }
}
