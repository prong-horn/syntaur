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
// Import the resolver directly (not via ./index.js) to avoid the
// argv→tui/launch import cycle the barrel would introduce.
import { resolveLaunchPrompt } from './launch-prompt.js';
import { playbooksDir } from '../utils/paths.js';
import { listPlaybookSlugs } from '../utils/playbooks.js';
import { formatFallbackCwdWarning, resolveWorkspaceCwd } from './cwd.js';
import { getSessionById } from '../dashboard/agent-sessions.js';
import { buildFreshArgv, buildSessionArgv } from './argv.js';
import type { ResolvedArgv } from './types.js';
import type { SessionMode } from './url.js';

export type LaunchErrorCode =
  | 'no-agents-configured'
  | 'assignment-not-found'
  | 'session-not-found'
  | 'agent-not-configured'
  | 'mode-not-supported'
  | 'workspace-path-invalid';

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
  /** Non-fatal launch-prompt token warnings (unknown/malformed `@`-tokens). */
  promptWarnings?: string[];
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
  /**
   * One-shot terminal override. When set, used in place of
   * `getTerminal(config)`. Wired through from `?terminal=<choice>` on the
   * incoming `syntaur://` URL so the dashboard's missing-terminal fallback
   * dialog can confirm a different terminal without mutating user config.
   */
  terminalOverride?: TerminalChoice;
  /**
   * Only consulted when `kind === 'assignment'`. The agent id to launch with,
   * wired from `?agent=<id>` on the incoming `syntaur://` URL so the dashboard's
   * "Open in agent" picker can launch a specific runner profile. When unset,
   * falls back to `pickAgent(config)` (the default agent). An unknown id throws
   * `LaunchError('agent-not-configured')`.
   */
  agentId?: string;
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
  const terminal = input.terminalOverride ?? getTerminal(input.config);

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

  const picked = resolveWorkspaceCwd({
    worktreePath: detail.workspace.worktreePath,
    repository: detail.workspace.repository,
    branch: detail.workspace.branch,
    assignmentSlug: resolved.assignmentSlug,
  });
  if (picked.cwd === null) {
    // No valid worktree or repository directory — refuse rather than silently
    // launching in the dashboard process cwd.
    throw new LaunchError('workspace-path-invalid', picked.invalidReason as string);
  }
  const cwd = picked.cwd;
  const fallbackWarning = picked.fallbackWarning;

  let agent: AgentConfig;
  if (input.agentId) {
    const found = getAgents(input.config).find((a) => a.id === input.agentId);
    if (!found) {
      throw new LaunchError(
        'agent-not-configured',
        `Agent "${input.agentId}" requested in the open URL is not in your agents list.`,
      );
    }
    agent = found;
  } else {
    agent = pickAgent(input.config);
  }
  const knownPlaybookSlugs = await listPlaybookSlugs(playbooksDir());
  const { prompt, warnings: promptWarnings } = resolveLaunchPrompt({
    template: agent.launchPrompt,
    playbook: agent.playbook,
    id: resolved.id,
    assignmentDir: resolved.assignmentDir,
    projectSlug: resolved.projectSlug,
    assignmentSlug: resolved.assignmentSlug,
    knownPlaybookSlugs,
  });
  const { argv, shellFallbackWarning } = buildFreshArgv(agent, prompt);

  return {
    terminal,
    cwd,
    argv,
    env: process.env,
    agentId: agent.id,
    fallbackWarning,
    shellFallbackWarning,
    promptWarnings,
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
      const picked = resolveWorkspaceCwd({
        worktreePath: detail.workspace.worktreePath,
        repository: detail.workspace.repository,
        branch: detail.workspace.branch,
        assignmentSlug: session.assignmentSlug,
      });
      if (picked.cwd !== null) {
        cwd = picked.cwd;
        fallbackWarning = picked.fallbackWarning;
      } else {
        // Neither worktree nor repository is a valid directory. Sessions keep
        // their recorded `session.path` (may be '') rather than failing the
        // launch — only assignment launches hard-error on an invalid workspace.
        fallbackWarning = formatFallbackCwdWarning({
          assignmentSlug: session.assignmentSlug,
          workspaceDir: session.path,
          worktreePath: detail.workspace.worktreePath,
          branch: detail.workspace.branch,
        });
      }
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

