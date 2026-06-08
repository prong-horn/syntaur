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
  /**
   * Optional LLM model for this runner profile, injected into the launched CLI
   * as a generic `--model <value>` flag (see `modelFlagArgs`). Blank/undefined
   * omits the flag entirely (today's behavior). Works for agents whose CLI
   * accepts `--model` (claude, codex); leave blank for agents that don't.
   */
  model?: string;
  /**
   * Optional playbook slug for this runner profile. When set, a fresh "Open in
   * agent" launch seeds a prompt that grabs the assignment AND runs this
   * playbook end-to-end (see `INITIAL_PROMPT`). Blank/undefined keeps the plain
   * `/grab-assignment` seed.
   */
  playbook?: string;
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

/**
 * Argv fragment that injects the profile's model as a generic `--model <value>`
 * flag, or `[]` when no model is set.
 */
export function modelFlagArgs(agent: AgentConfig): string[] {
  const m = agent.model?.trim();
  return m ? ['--model', m] : [];
}

/**
 * Remove any existing `--model`/`-m` flag (and its value) from an argv list.
 * Handles both the separate (`--model opus`) and combined (`--model=opus`,
 * `-m=opus`) forms.
 */
function stripModelFlags(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--model' || a === '-m') {
      i++; // also skip the following value token
      continue;
    }
    if (a.startsWith('--model=') || a.startsWith('-m=')) continue;
    out.push(a);
  }
  return out;
}

/**
 * Apply the profile's model to a base argv list. When the profile sets a model,
 * any pre-existing `--model`/`-m` in `baseArgs` is stripped first and the
 * profile flag appended — the profile model is authoritative AND we never emit a
 * duplicate `--model` (Codex 0.135.0 rejects duplicate `--model` outright; it is
 * not last-wins). When the profile has no model, `baseArgs` is returned
 * unchanged so a hand-written `--model` in `args` still works.
 */
export function applyModelFlag(agent: AgentConfig, baseArgs: string[]): string[] {
  const flag = modelFlagArgs(agent);
  if (flag.length === 0) return baseArgs;
  return [...stripModelFlags(baseArgs), ...flag];
}
