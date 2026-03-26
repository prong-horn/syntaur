import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { expandHome } from '../utils/paths.js';
import { fileExists } from '../utils/fs.js';
import { readConfig } from '../utils/config.js';
import { appendSession } from '../dashboard/agent-sessions.js';
import type { AgentSessionStatus } from '../dashboard/types.js';

export interface TrackSessionOptions {
  mission: string;
  assignment: string;
  agent: string;
  sessionId?: string;
  path?: string;
  dir?: string;
}

export async function trackSessionCommand(
  options: TrackSessionOptions,
): Promise<void> {
  if (!options.mission) {
    throw new Error('--mission <slug> is required.');
  }
  if (!options.assignment) {
    throw new Error('--assignment <slug> is required.');
  }
  if (!options.agent) {
    throw new Error('--agent <name> is required.');
  }

  const config = await readConfig();
  const baseDir = options.dir
    ? expandHome(options.dir)
    : config.defaultMissionDir;
  const missionDir = resolve(baseDir, options.mission);

  const indexPath = resolve(missionDir, '_index-sessions.md');
  if (!(await fileExists(missionDir)) || !(await fileExists(indexPath))) {
    throw new Error(
      `Mission "${options.mission}" not found at ${missionDir}, or _index-sessions.md is missing.`,
    );
  }

  const sessionId = options.sessionId || randomUUID();

  await appendSession(missionDir, {
    missionSlug: options.mission,
    assignmentSlug: options.assignment,
    agent: options.agent,
    sessionId,
    started: new Date().toISOString(),
    status: 'active' as AgentSessionStatus,
    path: options.path || process.cwd(),
  });

  console.log(`Registered agent session ${sessionId} for ${options.assignment} in ${options.mission}.`);
}
