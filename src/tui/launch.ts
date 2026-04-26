import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { getAssignmentDetail } from '../dashboard/api.js';
import type { AgentConfig } from '../utils/config.js';

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
}

export const INITIAL_PROMPT = (assignmentDir: string): string =>
  `Read the current Syntaur assignment at ${assignmentDir}/assignment.md and give me a brief summary: title, status, priority, objective, and acceptance criteria.`;

/**
 * Build the one-line warning emitted when a launch falls back to a cwd because
 * the assignment is missing `workspace.worktreePath` and/or `workspace.branch`.
 * Returns null when both fields are populated (no warning needed).
 */
export function formatFallbackCwdWarning(opts: {
  assignmentSlug: string;
  workspaceDir: string;
  worktreePath: string | null;
  branch: string | null;
}): string | null {
  const missing: string[] = [];
  if (!opts.worktreePath) missing.push('worktreePath');
  if (!opts.branch) missing.push('branch');
  if (missing.length === 0) return null;
  const fields = missing.map((m) => `workspace.${m}`).join(' and ');
  return `syntaur: ${fields} not set for ${opts.assignmentSlug} — launching in ${opts.workspaceDir}`;
}

/**
 * POSIX single-quote shell escaping. Safe to embed in `sh -c '<result>'`.
 * Replaces ' with '\'' and wraps the whole value in single quotes.
 */
export function shellQuote(arg: string): string {
  if (arg === '') return "''";
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

interface ResolvedArgv {
  command: string;
  args: string[];
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
): { argv: ResolvedArgv; shellFallbackWarning: string | null } {
  const position = agent.promptArgPosition ?? 'first';
  const baseArgs = [...(agent.args ?? [])];
  const agentArgs =
    position === 'first'
      ? [prompt, ...baseArgs]
      : position === 'last'
        ? [...baseArgs, prompt]
        : baseArgs;

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

  const resolvedFromWorkspace =
    cwdOverride ??
    detail.workspace.worktreePath ??
    (detail.workspace.repository?.startsWith('/') ? detail.workspace.repository : null);
  const workspaceDir = resolvedFromWorkspace ?? process.cwd();

  if (!cwdOverride) {
    const warning = formatFallbackCwdWarning({
      assignmentSlug,
      workspaceDir,
      worktreePath: detail.workspace.worktreePath,
      branch: detail.workspace.branch,
    });
    if (warning) console.warn(warning);
  }

  const contextDir = resolve(workspaceDir, '.syntaur');
  await mkdir(contextDir, { recursive: true });

  const context = {
    projectSlug,
    assignmentSlug,
    projectDir,
    assignmentDir,
    workspaceRoot: workspaceDir,
    title: detail.title,
    branch: detail.workspace.branch ?? null,
    grabbedAt: new Date().toISOString(),
  };

  await writeFile(
    resolve(contextDir, 'context.json'),
    JSON.stringify(context, null, 2) + '\n',
  );

  const { argv, shellFallbackWarning } = buildAgentArgv(
    agent,
    INITIAL_PROMPT(assignmentDir),
  );
  if (shellFallbackWarning) {
    console.warn(shellFallbackWarning);
  }

  return new Promise<void>((resolvePromise) => {
    const child = spawn(argv.command, argv.args, {
      cwd: workspaceDir,
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
