import { isAbsolute } from 'node:path';
import type { AgentConfig } from '../utils/config.js';
import { buildAgentArgv, shellQuote } from '../tui/launch.js';
import type { BuiltArgv } from './types.js';

/**
 * Re-export the fresh-launch argv builder under a parallel name so the launch
 * core has a single import surface: `buildFreshArgv` (new run) and
 * `buildResumeArgv` (resume an existing session).
 */
export const buildFreshArgv = buildAgentArgv;

/**
 * Build argv for resuming an existing agent session. Differs from
 * `buildAgentArgv` in one way: no initial prompt is injected — instead
 * `--resume <sessionId>` is appended to the agent's base args. The
 * `resolveFromShellAliases` rewriting is preserved identically (the command is
 * rewritten to `$SHELL`/`/bin/sh` and args become `['-i', '-c', '<quoted>']`).
 *
 * The shape matches `buildAgentArgv` so callers can consume `argv.command` and
 * `argv.args` uniformly.
 */
export function buildResumeArgv(
  agent: AgentConfig,
  sessionId: string,
  env: NodeJS.ProcessEnv = process.env,
): BuiltArgv {
  const agentArgs = [...(agent.args ?? []), '--resume', sessionId];

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
