import { resolve } from 'node:path';
import { expandHome } from '../utils/paths.js';
import { fileExists } from '../utils/fs.js';
import { readConfig } from '../utils/config.js';
import { derivePathFromTranscript } from '../utils/transcript.js';
import { captureProcessStartedAt } from '../utils/process-info.js';
import { captureHeadSha } from '../utils/git-worktree.js';
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

export async function trackSessionCommand(
  options: TrackSessionOptions,
): Promise<void> {
  if (!options.agent) {
    throw new Error('--agent <name> is required.');
  }

  if (!options.sessionId) {
    throw new Error(
      '--session-id <id> is required. Pass the real agent-generated session id — do not synthesize one.',
    );
  }

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

  const { sessionId } = options;

  // Prefer the launch cwd recorded in the transcript itself — that's the
  // directory Claude Code uses to file the transcript, and the only one from
  // which `claude --resume <id>` can find it. Falls through to the explicit
  // --path or the registering process's cwd when no transcript is supplied
  // (or it isn't readable yet).
  const derivedPath = await derivePathFromTranscript(options.transcriptPath);
  const recordedPath = derivedPath ?? options.path ?? process.cwd();

  const pid = options.pid ?? null;
  const pidStartedAt = pid !== null ? captureProcessStartedAt(pid) : null;

  // Best-effort capture of the worktree's HEAD sha so a later recreate of a
  // deleted worktree can be exact. Never blocks registration on git.
  const originalHeadSha = isExistingDir(recordedPath)
    ? await captureHeadSha(recordedPath)
    : null;

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
