import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { expandHome } from '../utils/paths.js';
import { fileExists } from '../utils/fs.js';
import { readConfig } from '../utils/config.js';
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
}

export async function trackSessionCommand(
  options: TrackSessionOptions,
): Promise<void> {
  if (!options.agent) {
    throw new Error('--agent <name> is required.');
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

  // Ensure the session database is initialized
  initSessionDb();

  const sessionId = options.sessionId || randomUUID();

  await appendSession('', {
    projectSlug: options.project || null,
    assignmentSlug: options.assignment || null,
    agent: options.agent,
    sessionId,
    started: new Date().toISOString(),
    status: 'active' as AgentSessionStatus,
    path: options.path || process.cwd(),
    description: options.description || null,
  });

  if (options.project && options.assignment) {
    console.log(`Registered agent session ${sessionId} for ${options.assignment} in ${options.project}.`);
  } else {
    console.log(`Registered standalone agent session ${sessionId}.`);
  }
}
