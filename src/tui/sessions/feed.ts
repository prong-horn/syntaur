import { listAllSessions } from '../../dashboard/agent-sessions.js';
import { enrichSessions, type LivenessDeps } from '../../dashboard/session-liveness.js';
import type { AgentConfig } from '../../utils/config.js';
import type { AgentSessionWithLiveness } from '../../dashboard/types.js';

export interface LoadSessionsOptions {
  projectsDir: string;
  agents: AgentConfig[];
  livenessDeps?: LivenessDeps;
}

export async function loadSessions(opts: LoadSessionsOptions): Promise<AgentSessionWithLiveness[]> {
  const sessions = await listAllSessions(opts.projectsDir);
  return enrichSessions(sessions, opts.agents, opts.livenessDeps);
}

export function liveOnly(sessions: AgentSessionWithLiveness[]): AgentSessionWithLiveness[] {
  return sessions.filter((s) => s.isLive);
}
