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
  // pi: resume/fork verified against `pi --help` (pi is installed) — `--session
  // <path|id>` continues a recorded session, `--fork <path|id>` forks one. (Not
  // `--resume`, which is an interactive picker that takes no id.)
  {
    id: 'pi',
    label: 'Pi',
    command: 'pi',
    resume: { args: ['--session', '{id}'] },
    fork: { args: ['--fork', '{id}'] },
  },
  // openclaw: resume/fork intentionally omitted. The openclaw binary is not
  // installed here, so its CLI cannot be verified; the only evidence it shares
  // pi's flags is a hedged design-memo assumption (see src/targets/registry.ts).
  // A missing recipe degrades gracefully to LaunchError('mode-not-supported'),
  // which a user can override via ~/.syntaur/config.md; a wrong recipe would
  // silently launch the wrong command. Add verified recipes once installable.
  {
    id: 'openclaw',
    label: 'OpenClaw',
    command: 'openclaw',
  },
  // hermes: resume/fork omitted — binary not installed and no resume/fork CLI is
  // documented for it. Ship launch-only; same graceful-degradation rationale.
  {
    id: 'hermes',
    label: 'Hermes',
    command: 'hermes',
  },
];

export const AGENT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;
export const PROMPT_ARG_POSITIONS: readonly PromptArgPosition[] = ['first', 'last', 'none'];
