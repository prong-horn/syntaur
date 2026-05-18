export type PromptArgPosition = 'first' | 'last' | 'none';

export interface AgentConfig {
  id: string;
  label: string;
  command: string;
  args?: string[];
  promptArgPosition?: PromptArgPosition;
  default?: boolean;
  resolveFromShellAliases?: boolean;
}

export const BUILTIN_AGENTS: AgentConfig[] = [
  { id: 'claude', label: 'Claude', command: 'claude', default: true },
  { id: 'codex', label: 'Codex', command: 'codex' },
];

export const AGENT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;
export const PROMPT_ARG_POSITIONS: readonly PromptArgPosition[] = ['first', 'last', 'none'];
