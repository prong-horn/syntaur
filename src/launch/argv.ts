import { isAbsolute } from 'node:path';
import type { AgentConfig } from '../utils/config.js';
import { buildAgentArgv, shellQuote } from '../tui/launch.js';
import type { BuiltArgv } from './types.js';
import { LaunchError } from './plan.js';
import type { SessionMode } from './url.js';

/**
 * Re-export the fresh-launch argv builder under a parallel name so the launch
 * core has a single import surface: `buildFreshArgv` (new run) and
 * `buildSessionArgv` (resume/fork an existing session).
 */
export const buildFreshArgv = buildAgentArgv;

/**
 * Build argv for continuing an existing agent session under a specific mode.
 *
 * The argv shape per agent is declared in `AgentConfig.resume` / `.fork`
 * (`SessionInvocation`):
 *   - `args` is a literal argv list. The substring `{id}` is replaced with
 *     `sessionId`.
 *   - `command` optionally overrides `agent.command` for subcommand-style
 *     agents whose binary differs (none in builtins).
 *
 * Existing `agent.args` (the base flags applied to a fresh launch — e.g.
 * `--dangerously-skip-permissions`) are preserved and prefixed before the
 * invocation args, matching the prior `buildResumeArgv` behavior.
 *
 * The `resolveFromShellAliases` rewriting is preserved identically: the
 * command is rewritten to `$SHELL`/`/bin/sh` and args become
 * `['-i', '-c', '<quoted>']`. The quoted command line uses the (possibly
 * overridden) executable.
 *
 * Throws `LaunchError('mode-not-supported', ...)` when the agent has no
 * entry for the requested mode.
 */
export function buildSessionArgv(
  agent: AgentConfig,
  sessionId: string,
  mode: SessionMode,
  env: NodeJS.ProcessEnv = process.env,
): BuiltArgv {
  const invocation = agent[mode];
  if (!invocation) {
    throw new LaunchError(
      'mode-not-supported',
      `Agent "${agent.id}" does not support ${mode} (no agent.${mode} configured)`,
    );
  }

  const substituted = invocation.args.map((a) =>
    a === '{id}' ? sessionId : a,
  );
  const command = invocation.command ?? agent.command;
  const agentArgs = [...(agent.args ?? []), ...substituted];

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
    const quoted = [command, ...agentArgs].map(shellQuote).join(' ');
    return {
      argv: { command: shell, args: ['-i', '-c', quoted] },
      shellFallbackWarning: warning,
    };
  }

  return {
    argv: { command, args: agentArgs },
    shellFallbackWarning: null,
  };
}
