import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { expandHome } from '../utils/paths.js';
import { fileExists } from '../utils/fs.js';
import { readConfig } from '../utils/config.js';
import { initSessionDb } from '../dashboard/session-db.js';
import { appendSession } from '../dashboard/agent-sessions.js';
import type { AgentSessionStatus } from '../dashboard/types.js';

export interface TrackSessionOptions {
  mission?: string;
  assignment?: string;
  agent: string;
  sessionId?: string;
  path?: string;
  dir?: string;
  description?: string;
}

export async function trackSessionCommand(
  options: TrackSessionOptions,
): Promise<void> {
  if (!options.agent) {
    throw new Error('--agent <name> is required.');
  }

  if (options.mission) {
    const config = await readConfig();
    const baseDir = options.dir
      ? expandHome(options.dir)
      : config.defaultMissionDir;
    const missionDir = resolve(baseDir, options.mission);

    if (!(await fileExists(missionDir))) {
      throw new Error(
        `Mission "${options.mission}" not found at ${missionDir}.`,
      );
    }
  }

  // Ensure the session database is initialized
  initSessionDb();

  const sessionId = options.sessionId || randomUUID();

  await appendSession('', {
    missionSlug: options.mission || null,
    assignmentSlug: options.assignment || null,
    agent: options.agent,
    sessionId,
    started: new Date().toISOString(),
    status: 'active' as AgentSessionStatus,
    path: options.path || process.cwd(),
    description: options.description || null,
  });

  if (options.mission && options.assignment) {
    console.log(`Registered agent session ${sessionId} for ${options.assignment} in ${options.mission}.`);
  } else {
    console.log(`Registered standalone agent session ${sessionId}.`);
  }
}
