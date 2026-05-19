import { isAbsolute } from 'node:path';
import {
  type AgentConfig,
  type SyntaurConfig,
  type TerminalChoice,
  getAgents,
  getTerminal,
} from '../utils/config.js';
import { resolveAssignmentById } from '../utils/assignment-resolver.js';
import {
  getAssignmentDetail,
  getAssignmentDetailById,
} from '../dashboard/api.js';
import {
  INITIAL_PROMPT,
  formatFallbackCwdWarning,
} from '../tui/launch.js';
import { getSessionById } from '../dashboard/agent-sessions.js';
import { buildFreshArgv, buildSessionArgv } from './argv.js';
import type { ResolvedArgv } from './types.js';
import type { SessionMode } from './url.js';

export type LaunchErrorCode =
  | 'no-agents-configured'
  | 'assignment-not-found'
  | 'session-not-found'
  | 'agent-not-configured'
  | 'mode-not-supported';

export class LaunchError extends Error {
  readonly code: LaunchErrorCode;
  constructor(code: LaunchErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = 'LaunchError';
  }
}

export interface LaunchPlan {
  terminal: TerminalChoice;
  cwd: string;
  argv: ResolvedArgv;
  env: NodeJS.ProcessEnv;
  agentId: string;
  /** Non-fatal warning about a fallback cwd (worktree path missing). */
  fallbackWarning: string | null;
  /** Non-fatal warning from shell-alias resolution falling back to /bin/sh. */
  shellFallbackWarning: string | null;
}

export interface ResolveLaunchPlanInput {
  kind: 'assignment' | 'session';
  id: string;
  /**
   * Only consulted when `kind === 'session'`. Defaults to `'resume'` so
   * callers that haven't been updated to thread the URL mode through still
   * get the prior behavior (continue the same session id).
   */
  mode?: SessionMode;
  config: SyntaurConfig;
  projectsDir: string;
  assignmentsDir: string;
}

/**
 * Pick the agent the "Open in agent" flow should use. Order of preference:
 * - the first agent with `default: true`
 * - else the first entry in the list
 * Throws LaunchError('no-agents-configured') if the list is empty (only
 * possible when the user explicitly wrote `agents: []` — absence falls back to
 * BUILTIN_AGENTS via `getAgents()`).
 */
export function pickAgent(config: SyntaurConfig): AgentConfig {
  const agents = getAgents(config);
  if (agents.length === 0) {
    throw new LaunchError(
      'no-agents-configured',
      'No agents in ~/.syntaur/config.md. Run `syntaur agents add` to configure one.',
    );
  }
  return agents.find((a) => a.default) ?? agents[0];
}

/**
 * Resolve the launch plan for a "Open in agent" click. Reads the assignment or
 * session record, picks the cwd + agent, builds the argv, and returns a
 * structured plan that `executeLaunchPlan` (or an Electron caller) can run.
 */
export async function resolveLaunchPlan(
  input: ResolveLaunchPlanInput,
): Promise<LaunchPlan> {
  const terminal = getTerminal(input.config);

  if (input.kind === 'assignment') {
    return resolveAssignmentPlan(input, terminal);
  }
  return resolveSessionPlan(input, terminal);
}

async function resolveAssignmentPlan(
  input: ResolveLaunchPlanInput,
  terminal: TerminalChoice,
): Promise<LaunchPlan> {
  const resolved = await resolveAssignmentById(
    input.projectsDir,
    input.assignmentsDir,
    input.id,
  );
  if (!resolved) {
    throw new LaunchError(
      'assignment-not-found',
      `Assignment with id ${JSON.stringify(input.id)} not found`,
    );
  }

  const detail = await getAssignmentDetailById(
    input.projectsDir,
    input.assignmentsDir,
    input.id,
  );
  if (!detail) {
    throw new LaunchError(
      'assignment-not-found',
      `Assignment ${input.id} resolver returned a directory but detail could not be loaded`,
    );
  }

  const { cwd, fallbackWarning } = pickCwd({
    worktreePath: detail.workspace.worktreePath,
    repository: detail.workspace.repository,
    branch: detail.workspace.branch,
    assignmentSlug: resolved.assignmentSlug,
    fallbackPath: process.cwd(),
  });

  const agent = pickAgent(input.config);
  const { argv, shellFallbackWarning } = buildFreshArgv(
    agent,
    INITIAL_PROMPT({
      projectSlug: resolved.projectSlug,
      assignmentSlug: resolved.assignmentSlug,
      id: resolved.id,
    }),
  );

  return {
    terminal,
    cwd,
    argv,
    env: process.env,
    agentId: agent.id,
    fallbackWarning,
    shellFallbackWarning,
  };
}

async function resolveSessionPlan(
  input: ResolveLaunchPlanInput,
  terminal: TerminalChoice,
): Promise<LaunchPlan> {
  const session = getSessionById(input.id);
  if (!session) {
    throw new LaunchError(
      'session-not-found',
      `Session with id ${JSON.stringify(input.id)} not found`,
    );
  }

  let cwd = session.path;
  let fallbackWarning: string | null = null;

  if (session.projectSlug && session.assignmentSlug) {
    const detail = await getAssignmentDetail(
      input.projectsDir,
      session.projectSlug,
      session.assignmentSlug,
    );
    if (detail) {
      const picked = pickCwd({
        worktreePath: detail.workspace.worktreePath,
        repository: detail.workspace.repository,
        branch: detail.workspace.branch,
        assignmentSlug: session.assignmentSlug,
        fallbackPath: session.path,
      });
      cwd = picked.cwd;
      fallbackWarning = picked.fallbackWarning;
    }
  }

  const agent = getAgents(input.config).find((a) => a.id === session.agent);
  if (!agent) {
    throw new LaunchError(
      'agent-not-configured',
      `Session ${input.id} was started with agent "${session.agent}" which is not in your agents list. Run \`syntaur agents add ${session.agent}\` or pick a different session.`,
    );
  }

  const { argv, shellFallbackWarning } = buildSessionArgv(
    agent,
    session.sessionId,
    input.mode ?? 'resume',
  );

  return {
    terminal,
    cwd,
    argv,
    env: process.env,
    agentId: agent.id,
    fallbackWarning,
    shellFallbackWarning,
  };
}

function pickCwd(input: {
  worktreePath: string | null;
  repository: string | null;
  branch: string | null;
  assignmentSlug: string;
  fallbackPath: string;
}): { cwd: string; fallbackWarning: string | null } {
  if (input.worktreePath && isAbsolute(input.worktreePath)) {
    return { cwd: input.worktreePath, fallbackWarning: null };
  }
  const workspaceDir =
    input.repository && isAbsolute(input.repository)
      ? input.repository
      : input.fallbackPath;
  const fallbackWarning = formatFallbackCwdWarning({
    assignmentSlug: input.assignmentSlug,
    workspaceDir,
    worktreePath: input.worktreePath,
    branch: input.branch,
  });
  return { cwd: workspaceDir, fallbackWarning };
}
