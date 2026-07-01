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
import {
  formatFallbackCwdWarning,
  isExistingDir,
  resolveLaunchCwd,
  resolveStandaloneCwd,
  resolveWorkspaceCwd,
} from './cwd.js';
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
  /**
   * Session identity at launch time, for register-at-birth. `sessionId` is only
   * known for resume-mode session launches; fresh/fork launches mint a NEW id
   * inside the agent, so they carry `null` and rely on the pending runtime
   * marker + scanner to close the gap. Absent on assignment launches.
   */
  session?: { sessionId: string | null };
}

export interface ResolveLaunchPlanInput {
  kind: 'assignment' | 'session' | 'standalone';
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
  /**
   * Only consulted when `kind === 'assignment'`. A one-shot launch-prompt
   * override, wired from `?prompt=<text>` on the incoming `syntaur://` URL (the
   * dashboard's editable prompt box). **Presence-significant:** when defined
   * (including `''`) it is used as the `template` for `resolveLaunchPrompt`
   * instead of `agent.launchPrompt`, so its `@`-tokens re-resolve and an empty
   * value falls back through the normal empty-template path (never silently
   * reusing `agent.launchPrompt`). Per-launch only — never written to config.
   */
  promptOverride?: string;
  /**
   * Only consulted when `kind === 'assignment'`. A one-shot Claude `--agent
   * <name>` identity, wired from `?agentName=<name>` on the incoming
   * `syntaur://` URL (the dashboard's discovered-agent picker). When defined it
   * is applied over the resolved agent before argv assembly, so the launched
   * session adopts that agent definition. Presence-significant; per-launch only.
   */
  agentName?: string;
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
  if (input.kind === 'standalone') {
    return resolveStandalonePlan(input, terminal);
  }
  return resolveSessionPlan(input, terminal);
}

/**
 * Resolve a standalone launch (`kind: 'standalone'`) — a directory-agent run
 * with NO assignment (e.g. the `pi-jobs` job-applier). The agent is identified
 * by `input.agentId`, spawned from its validated `workdir`; no worktree, no
 * context.json. With no template/playbook the prompt resolves to empty.
 */
async function resolveStandalonePlan(
  input: ResolveLaunchPlanInput,
  terminal: TerminalChoice,
): Promise<LaunchPlan> {
  const agentId = input.agentId ?? input.id;
  if (!agentId) {
    throw new LaunchError(
      'agent-not-configured',
      'A standalone launch requires an agent id.',
    );
  }
  const agent = getAgents(input.config).find((a) => a.id === agentId);
  if (!agent) {
    throw new LaunchError(
      'agent-not-configured',
      `Agent "${agentId}" requested for a standalone launch is not in your agents list.`,
    );
  }

  const { cwd: spawnCwd, invalidReason } = resolveStandaloneCwd(
    agent,
    input.config.standaloneDefaultCwd,
  );
  if (spawnCwd === null) {
    throw new LaunchError(
      'workspace-path-invalid',
      invalidReason ?? `Agent "${agent.id}" has no valid standalone launch directory.`,
    );
  }

  const knownPlaybookSlugs = await listPlaybookSlugs(playbooksDir());
  const template =
    input.promptOverride !== undefined ? input.promptOverride : agent.launchPrompt;
  const { prompt, warnings: promptWarnings } = resolveLaunchPrompt({
    template,
    playbook: agent.playbook,
    projectSlug: null,
    knownPlaybookSlugs,
  });
  const { argv, shellFallbackWarning } = buildFreshArgv(agent, prompt);

  return {
    terminal,
    cwd: spawnCwd,
    argv,
    env: process.env,
    agentId: agent.id,
    fallbackWarning: null,
    shellFallbackWarning,
    promptWarnings,
  };
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

  // Resolve the agent FIRST: a directory-agent (`workdir`) overrides the spawn
  // cwd, so the agent identity must be known before we settle on a cwd.
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
  // One-shot Claude `--agent <name>` override (presence-significant), applied
  // over the resolved agent so the launched session adopts that identity.
  if (input.agentName !== undefined) {
    agent = { ...agent, agentName: input.agentName };
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
  // A directory-agent overrides the spawn cwd while keeping the worktree path
  // for context.json / `@worktree`. An invalid `workdir` refuses the launch.
  const launchCwd = resolveLaunchCwd(agent, picked.cwd);
  if (launchCwd.invalidReason) {
    throw new LaunchError('workspace-path-invalid', launchCwd.invalidReason);
  }
  const cwd = launchCwd.spawnCwd;
  const fallbackWarning = picked.fallbackWarning;

  const promptWarningsExtra: string[] = [];
  // Non-silent model suppression: a one-shot agentName override applied over a
  // base agent that carried its own model drops that model (the agent
  // definition's frontmatter model wins) — surface it rather than swallow it.
  if (input.agentName !== undefined && input.agentName.trim() && agent.model?.trim()) {
    promptWarningsExtra.push(
      `profile model "${agent.model.trim()}" suppressed: agent "${input.agentName.trim()}" defines its own model`,
    );
  }

  const knownPlaybookSlugs = await listPlaybookSlugs(playbooksDir());
  // A defined promptOverride (incl. '') wins over the stored template by
  // presence — clearing the box must not silently reuse agent.launchPrompt.
  const template =
    input.promptOverride !== undefined ? input.promptOverride : agent.launchPrompt;
  const { prompt, warnings: promptWarnings } = resolveLaunchPrompt({
    template,
    playbook: agent.playbook,
    id: resolved.id,
    assignmentDir: resolved.assignmentDir,
    projectSlug: resolved.projectSlug,
    assignmentSlug: resolved.assignmentSlug,
    worktreePath: launchCwd.worktreePath,
    spawnCwd: launchCwd.spawnCwd,
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
    promptWarnings: [...promptWarningsExtra, ...promptWarnings],
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

  // The session's recorded cwd is where the agent indexed its transcript
  // (Claude Code: ~/.claude/projects/<encoded-cwd>/<id>.jsonl); `--resume <id>`
  // only finds the session from THAT cwd. So when session.path is a real
  // directory it is authoritative and must win over the assignment's *current*
  // workspace — otherwise two sessions on one assignment that ran in different
  // cwds (e.g. repo root vs a worktree) both resolve to the same worktree and
  // collapse onto one transcript. This mirrors resolveRecreateTarget, which
  // already treats session.path as the authoritative path to rebuild. Only when
  // session.path is missing/invalid do we fall back to the linked assignment's
  // workspace cwd (and let preflight/recreate recover a deleted worktree).
  if (!isExistingDir(session.path)) {
    // Resolve the linked assignment the same way resolveRecreateTarget does:
    // project-nested sessions key on (projectSlug, assignmentSlug); standalone
    // sessions store the assignment UUID in assignmentSlug (project_slug IS
    // NULL) and resolve by id. Either may be absent (a session with no linked
    // assignment) → no fallback, keep session.path.
    const detail =
      session.projectSlug && session.assignmentSlug
        ? await getAssignmentDetail(
            input.projectsDir,
            session.projectSlug,
            session.assignmentSlug,
          )
        : session.assignmentSlug
          ? await getAssignmentDetailById(
              input.projectsDir,
              input.assignmentsDir,
              session.assignmentSlug,
            )
          : null;
    if (detail) {
      const picked = resolveWorkspaceCwd({
        worktreePath: detail.workspace.worktreePath,
        repository: detail.workspace.repository,
        branch: detail.workspace.branch,
        assignmentSlug: detail.slug,
      });
      if (picked.cwd !== null) {
        cwd = picked.cwd;
        fallbackWarning = picked.fallbackWarning;
      } else {
        // Neither worktree nor repository is a valid directory. Sessions keep
        // their recorded `session.path` (may be '') rather than failing the
        // launch — only assignment launches hard-error on an invalid workspace.
        fallbackWarning = formatFallbackCwdWarning({
          assignmentSlug: detail.slug,
          workspaceDir: session.path,
          worktreePath: detail.workspace.worktreePath,
          branch: detail.workspace.branch,
        });
      }
    }
  }

  // Refuse a blank cwd: buildShellCommandLine would render `cd '' && <agent>`,
  // a POSIX no-op that silently runs in the spawner's cwd (wrong directory, no
  // error). A non-empty-but-stale `session.path` is intentionally preserved
  // above — preflight/recreate recovers a deleted worktree and the literal
  // path is visible in copied commands — so ONLY a blank cwd is unrecoverable
  // and hard-fails, mirroring resolveAssignmentPlan's workspace-path-invalid.
  if (!cwd.trim()) {
    throw new LaunchError(
      'workspace-path-invalid',
      `Session ${input.id} has no recorded working directory and no linked assignment workspace resolved — refusing to launch in an unknown directory.`,
    );
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
    // Resume continues the SAME session id; fork mints a new one in-agent.
    session: { sessionId: (input.mode ?? 'resume') === 'resume' ? session.sessionId : null },
  };
}

