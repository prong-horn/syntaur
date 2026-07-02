import { isAbsolute, resolve } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { getAssignmentDetail } from '../dashboard/api.js';
import type { AgentConfig } from '../utils/config.js';
import { agentNameArgs, applyModelFlag } from '../utils/agents-schema.js';
import type { BuiltArgv } from './types.js';
import {
  formatFallbackCwdWarning,
  isExistingDir,
  resolveLaunchCwd,
  resolveWorkspaceCwd,
} from './cwd.js';
import { resolveLaunchPrompt } from './launch-prompt.js';
import { playbooksDir } from '../utils/paths.js';
import { listPlaybookSlugs } from '../utils/playbooks.js';

/**
 * POSIX single-quote shell escaping. Safe to embed in `sh -c '<result>'`.
 * Replaces ' with '\'' and wraps the whole value in single quotes.
 *
 * Lives here (rather than `../tui/launch.ts`) so `buildLaunchPlan` below can
 * call `buildAgentArgv` without creating an import cycle back to
 * `tui/launch.ts` (which imports `buildLaunchPlan` from this module).
 * `tui/launch.ts` re-exports both for backward compatibility with existing
 * `import { buildAgentArgv, shellQuote } from '../tui/launch.js'` call sites
 * (e.g. `launch-argv.test.ts`, `launch/argv.ts`, `launch/execute.ts`).
 */
export function shellQuote(arg: string): string {
  if (arg === '') return "''";
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

/**
 * Build argv for an agent launch. Handles:
 * - `resolveFromShellAliases: true` → `$SHELL -i -c '<quoted...>'`
 * - `promptArgPosition: 'first' | 'last' | 'none'`
 * - plain absolute or bare-name command.
 */
export function buildAgentArgv(
  agent: AgentConfig,
  prompt: string,
  env: NodeJS.ProcessEnv = process.env,
): BuiltArgv {
  const position = agent.promptArgPosition ?? 'first';
  // Claude `--agent <name>` is a command-PREFIX: it must sit immediately after
  // the command and before the positioned prompt (with `promptArgPosition:
  // 'first'` a naive prepend would yield `claude <prompt> --agent <name>`).
  const prefix = agentNameArgs(agent);
  // When an agent identity is selected its own model frontmatter wins, so the
  // profile `--model` is suppressed on a fresh launch. Otherwise the profile
  // model is appended after the agent's own args (any pre-existing `--model` is
  // stripped first) so exactly one authoritative `--model` is emitted — never a
  // duplicate, which some CLIs reject.
  const baseArgs = agent.agentName
    ? [...(agent.args ?? [])]
    : applyModelFlag(agent, [...(agent.args ?? [])]);
  const positioned =
    position === 'first'
      ? [prompt, ...baseArgs]
      : position === 'last'
        ? [...baseArgs, prompt]
        : baseArgs;
  const agentArgs = [...prefix, ...positioned];

  if (agent.resolveFromShellAliases) {
    const requested = env.SHELL;
    let shell = requested;
    let warning: string | null = null;
    if (!shell || !isAbsolute(shell)) {
      warning = `syntaur: $SHELL ${
        requested ? `("${requested}") is not absolute` : 'is unset'
      } — falling back to /bin/sh for shell-alias resolution`;
      shell = '/bin/sh';
    }
    const quoted = [agent.command, ...agentArgs].map(shellQuote).join(' ');
    return {
      argv: { command: shell, args: ['-i', '-c', quoted] },
      shellFallbackWarning: warning,
    };
  }

  return {
    argv: { command: agent.command, args: agentArgs },
    shellFallbackWarning: null,
  };
}

/** The resolved spawn invocation for an agent launch: what to run, and from where. */
export interface AgentLaunchPlan {
  command: string;
  args: string[];
  cwd: string;
}

/**
 * Resolve everything `launchAgent` needs BEFORE spawning: validate the
 * working directory, write the `.syntaur/context.json` workspace marker,
 * resolve the launch prompt, and build the final argv. Returns the plan
 * without spawning anything, so both a detached tmux launch and a
 * hand-off (inherit-stdio, in-process) launch can share this exact path.
 *
 * `projectSlug` is NON-null here (unlike `AgentSession.projectSlug`, which is
 * nullable) — a standalone (non-project) assignment launch is out of scope for
 * v1; callers must gate on a project-nested assignment selection before
 * calling this.
 *
 * Throws an `Error` (never calls `process.exit`) when the assignment can't be
 * found or the working directory can't be validated, so callers decide how to
 * report/exit.
 */
export async function buildLaunchPlan(input: {
  projectsDir: string;
  projectSlug: string;
  assignmentSlug: string;
  agent: AgentConfig;
  cwdOverride?: string;
}): Promise<AgentLaunchPlan> {
  const { projectsDir, projectSlug, assignmentSlug, agent, cwdOverride } = input;

  const detail = await getAssignmentDetail(projectsDir, projectSlug, assignmentSlug);
  if (!detail) {
    throw new Error(`Assignment not found: ${projectSlug}/${assignmentSlug}`);
  }

  const projectDir = resolve(projectsDir, projectSlug);
  const assignmentDir = resolve(projectDir, 'assignments', assignmentSlug);

  // Resolve + VALIDATE the working directory before writing context.json or
  // spawning. Never silently fall back to process.cwd() — refuse the launch so
  // we don't open the agent (or write context) in the wrong directory. This
  // resolves the WORKTREE dir; a directory-agent (`workdir`) moves the SPAWN cwd
  // off it below while keeping the worktree as the context-marker home.
  let worktreeDir: string;
  if (cwdOverride) {
    // An explicit, present-but-invalid override is a caller bug — hard error
    // rather than silently falling through to the workspace fields.
    if (!isExistingDir(cwdOverride)) {
      throw new Error(
        `syntaur: --cwd ${cwdOverride} is not an existing directory — refusing to launch.`,
      );
    }
    worktreeDir = cwdOverride;
  } else {
    const picked = resolveWorkspaceCwd({
      worktreePath: detail.workspace.worktreePath,
      repository: detail.workspace.repository,
      branch: detail.workspace.branch,
      assignmentSlug,
    });
    if (picked.cwd === null) {
      throw new Error(`syntaur: ${picked.invalidReason} — refusing to launch.`);
    }
    worktreeDir = picked.cwd;
    // Preserve the existing missing-field warning behavior: when worktree is
    // valid but `branch` (or worktreePath) is unset we still nudge the user.
    // `picked.fallbackWarning` covers the worktree→repository fallback cases.
    const warning =
      picked.fallbackWarning ??
      formatFallbackCwdWarning({
        assignmentSlug,
        workspaceDir: worktreeDir,
        worktreePath: detail.workspace.worktreePath,
        branch: detail.workspace.branch,
      });
    if (warning) console.warn(warning);
  }

  // A directory-agent spawns from its own `workdir`; the worktree stays the
  // home for context.json + `@worktree`. An invalid workdir refuses the launch.
  const launchCwd = resolveLaunchCwd(agent, worktreeDir);
  if (launchCwd.invalidReason) {
    throw new Error(`syntaur: ${launchCwd.invalidReason} — refusing to launch.`);
  }
  const spawnCwd = launchCwd.spawnCwd;
  const worktreePath = launchCwd.worktreePath;

  // context.json is a WORKSPACE MARKER file — it records repository/branch/
  // worktree so tooling can recognize this directory as a Syntaur workspace. It
  // is written to the WORKTREE, never the agent's `workdir`: marking a global
  // agent dir (e.g. ~/job-applier-agent) as a Syntaur workspace would be wrong.
  // It is NOT the active-assignment source of truth: the assignment binds via
  // the session's open engagement (established by `syntaur track-session`).
  // Do NOT persist projectSlug/assignmentSlug/assignmentDir/projectDir/title
  // here — those scalars are non-authoritative and resolve from the engagement.
  const contextDir = resolve(worktreePath, '.syntaur');
  await mkdir(contextDir, { recursive: true });

  const context = {
    repository: detail.workspace.repository ?? null,
    branch: detail.workspace.branch ?? null,
    worktreePath: detail.workspace.worktreePath ?? null,
    workspaceRoot: worktreePath,
    grabbedAt: new Date().toISOString(),
  };

  await writeFile(
    resolve(contextDir, 'context.json'),
    JSON.stringify(context, null, 2) + '\n',
  );

  const knownPlaybookSlugs = await listPlaybookSlugs(playbooksDir());
  const { prompt, warnings } = resolveLaunchPrompt({
    template: agent.launchPrompt,
    playbook: agent.playbook,
    id: detail.id,
    assignmentDir,
    projectSlug,
    assignmentSlug,
    worktreePath,
    spawnCwd,
    knownPlaybookSlugs,
  });
  for (const warning of warnings) console.warn(warning);

  const { argv, shellFallbackWarning } = buildAgentArgv(agent, prompt);
  if (shellFallbackWarning) {
    console.warn(shellFallbackWarning);
  }

  return { command: argv.command, args: argv.args, cwd: spawnCwd };
}
