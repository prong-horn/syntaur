import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { getAssignmentDetail } from '../dashboard/api.js';
import type { AgentConfig } from '../utils/config.js';
import { agentNameArgs, applyModelFlag } from '../utils/agents-schema.js';
import type { BuiltArgv } from '../launch/types.js';
import {
  formatFallbackCwdWarning,
  isExistingDir,
  resolveLaunchCwd,
  resolveWorkspaceCwd,
} from '../launch/cwd.js';
import type { SpawnFn } from '../launch/execute.js';
import { bareGrabSeed, resolveLaunchPrompt } from '../launch/launch-prompt.js';
import { playbooksDir } from '../utils/paths.js';
import { listPlaybookSlugs } from '../utils/playbooks.js';

export type { ResolvedArgv, BuiltArgv } from '../launch/types.js';
// `formatFallbackCwdWarning` now lives in ../launch/cwd.ts (a neutral module so
// plan.ts can import the cwd helpers without a cycle). Re-exported here so the
// existing `import { formatFallbackCwdWarning } from '../tui/launch.js'` sites
// (e.g. launch-argv.test.ts) keep working.
export { formatFallbackCwdWarning } from '../launch/cwd.js';

export interface LaunchOptions {
  projectsDir: string;
  projectSlug: string;
  assignmentSlug: string;
  agent: AgentConfig;
  cwdOverride?: string;
  /**
   * Test hook: called with the exit code of the spawned child instead of
   * `process.exit(code)`. Default behavior is `process.exit`. Production
   * callers should leave this unset.
   */
  onExit?: (code: number) => void;
  /**
   * Test hook: replaces `child_process.spawn` so unit tests can assert exactly
   * what (and with which cwd) the launcher invoked without spawning a real
   * process. Default is the real `spawn`. Production callers leave this unset.
   */
  spawnFn?: SpawnFn;
}

/**
 * Initial message sent to the agent the first time it starts up at an
 * assignment. This is the protocol entry point: `/grab-assignment` is the
 * Claude Code skill that loads project/playbook/memory context for the
 * assignment and (per its pre-flight check) prompts the user if a different
 * assignment is already active in this workspace.
 *
 * Argument shapes match the skill's documented input:
 *   - project-nested: `/grab-assignment <project-slug> <assignment-slug>`
 *   - standalone:     `/grab-assignment --id <uuid>`
 *
 * When `playbook` is set (an agent runner profile), the seed switches to an
 * instruction-style message that chains BOTH `/grab-assignment` and
 * `/run-playbook`. This is deliberate: a Claude Code message fires only ONE
 * leading slash-command — everything after it is swallowed as that command's
 * arguments — so two slash-commands cannot be issued from a single seed. A
 * plain-language instruction lets the agent invoke both skills itself
 * (grab-assignment loads playbook *context*; run-playbook *executes* a specific
 * enabled playbook end-to-end — complementary, not redundant). The no-playbook
 * path keeps the exact, well-tested `/grab-assignment` invocation unchanged.
 */
/**
 * @deprecated Both launch call sites now route through `resolveLaunchPrompt`
 * (`../launch/launch-prompt.js`), which supports the editable `launchPrompt`
 * field. `INITIAL_PROMPT` is retained only for its existing tests / transitional
 * reference; its no-playbook branch shares `bareGrabSeed` with the resolver so
 * those bare-seed strings stay byte-identical.
 */
export const INITIAL_PROMPT = (params: {
  projectSlug: string | null;
  assignmentSlug: string;
  id?: string;
  playbook?: string | null;
}): string => {
  const playbook = params.playbook?.trim();

  if (!playbook) {
    return bareGrabSeed({
      projectSlug: params.projectSlug,
      assignmentSlug: params.assignmentSlug,
      id: params.id,
    });
  }

  // Playbook profile: chain grab + run-playbook via a plain-language seed.
  const grabClause = params.projectSlug
    ? `the assignment \`${params.projectSlug}/${params.assignmentSlug}\` using the /grab-assignment skill`
    : params.id
      ? `the assignment id \`${params.id}\` using /grab-assignment --id ${params.id}`
      : `the assignment \`${params.assignmentSlug}\` using the /grab-assignment skill`;
  return (
    `Grab ${grabClause}, then load and run the \`${playbook}\` playbook ` +
    `using the /run-playbook skill and carry it out end-to-end.`
  );
};

/**
 * POSIX single-quote shell escaping. Safe to embed in `sh -c '<result>'`.
 * Replaces ' with '\'' and wraps the whole value in single quotes.
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

export async function launchAgent(options: LaunchOptions): Promise<void> {
  const { projectsDir, projectSlug, assignmentSlug, agent, cwdOverride } = options;
  const exitWith = options.onExit ?? ((code: number) => process.exit(code));

  const detail = await getAssignmentDetail(projectsDir, projectSlug, assignmentSlug);
  if (!detail) {
    console.error(`Assignment not found: ${projectSlug}/${assignmentSlug}`);
    process.exit(1);
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
      console.error(
        `syntaur: --cwd ${cwdOverride} is not an existing directory — refusing to launch.`,
      );
      exitWith(1);
      return;
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
      console.error(`syntaur: ${picked.invalidReason} — refusing to launch.`);
      exitWith(1);
      return;
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
    console.error(`syntaur: ${launchCwd.invalidReason} — refusing to launch.`);
    exitWith(1);
    return;
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

  const spawnImpl = options.spawnFn ?? spawn;
  return new Promise<void>((resolvePromise) => {
    const child = spawnImpl(argv.command, argv.args, {
      cwd: spawnCwd,
      stdio: 'inherit',
    });

    child.on('error', (err) => {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        console.error(
          `syntaur: agent "${agent.id}" command "${agent.command}" not found. ` +
            `If "${agent.command}" is a shell alias, set resolveFromShellAliases: true on this agent in ~/.syntaur/config.md.`,
        );
      } else if (code === 'EACCES') {
        console.error(
          `syntaur: agent "${agent.id}" command "${agent.command}" is not executable (EACCES). ` +
            `Check file permissions.`,
        );
      } else {
        console.error(
          `syntaur: failed to launch agent "${agent.id}" (${code ?? 'unknown'}): ${err.message}`,
        );
      }
      resolvePromise();
      exitWith(1);
    });

    child.on('exit', (code) => {
      resolvePromise();
      exitWith(code ?? 0);
    });
  });
}
