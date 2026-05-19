export type PromptArgPosition = 'first' | 'last' | 'none';

/**
 * Per-agent argv recipe for continuing a recorded session in a specific mode.
 *
 * `args` is a literal argv list with the substring `{id}` substituted for the
 * agent's session id at launch time. `command` overrides the agent's main
 * `command` field — used by subcommand-style agents (e.g. `codex resume <id>`
 * is documented as command=codex, args=['resume','{id}']; the override exists
 * for future agents whose subcommand binary differs).
 */
export interface SessionInvocation {
  command?: string;
  args: string[];
}

export interface AgentConfig {
  id: string;
  label: string;
  command: string;
  args?: string[];
  promptArgPosition?: PromptArgPosition;
  default?: boolean;
  resolveFromShellAliases?: boolean;
  resume?: SessionInvocation;
  fork?: SessionInvocation;
}

export const BUILTIN_AGENTS: AgentConfig[] = [
  {
    id: 'claude',
    label: 'Claude',
    command: 'claude',
    default: true,
    resume: { args: ['--resume', '{id}'] },
    fork: { args: ['--resume', '{id}', '--fork-session'] },
  },
  {
    id: 'codex',
    label: 'Codex',
    command: 'codex',
    resume: { args: ['resume', '{id}'] },
    fork: { args: ['fork', '{id}'] },
  },
];

export const AGENT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;
export const PROMPT_ARG_POSITIONS: readonly PromptArgPosition[] = ['first', 'last', 'none'];
