import { useChatAgents } from '../hooks/useChatAgents';

interface StartAgentPickerProps {
  /** Template default for the destination stage (the untouched selection). */
  defaultAgentId: string | null;
  /** Template auto policy for the destination stage. */
  defaultAuto?: boolean;
  value: string | null;
  onChange: (agentId: string | null) => void;
  disabled?: boolean;
}

/** Label for the untouched option: Start sends no override and follows template policy. */
export function startDefaultOptionLabel(defaultAgentId: string | null, defaultAuto: boolean): string {
  if (!defaultAgentId) return 'No default agent';
  return defaultAuto ? `Default: @${defaultAgentId}` : `Default: @${defaultAgentId} (manual)`;
}

/** Map a picker value to the one-use override; the default (or empty) option is no override. */
export function startPickerSelection(
  value: string,
  defaultAgentId: string | null,
): string | null {
  if (!value || value === defaultAgentId) return null;
  return value;
}

export function StartAgentPicker({
  defaultAgentId,
  defaultAuto = true,
  value,
  onChange,
  disabled,
}: StartAgentPickerProps) {
  const { data: agentsData } = useChatAgents();
  const agents = (agentsData?.agents ?? []).filter((agent) => agent.id !== defaultAgentId);
  const title =
    defaultAgentId && !defaultAuto
      ? 'One-use dispatch recipient for Start. The default does not dispatch automatically; use Hand to after start.'
      : 'One-use dispatch recipient for Start (does not change chat default)';

  return (
    <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
      <span className="sr-only">Start dispatch agent override</span>
      <select
        className="max-w-[10rem] rounded border border-border bg-background px-1.5 py-0.5 text-xs text-foreground disabled:opacity-50"
        value={value ?? ''}
        onChange={(e) => onChange(startPickerSelection(e.target.value, defaultAgentId))}
        disabled={disabled}
        title={title}
      >
        <option value="">{startDefaultOptionLabel(defaultAgentId, defaultAuto)}</option>
        {agents.map((agent) => (
          <option key={agent.id} value={agent.id} disabled={agent.respondsTo === 'none'}>
            @{agent.id}
            {agent.respondsTo === 'none' ? ' (disabled)' : ''}
          </option>
        ))}
      </select>
    </label>
  );
}

/**
 * The `agent` sent with Start. Only a deliberate non-default choice is an
 * override; the template default is never sent, so an untouched Start follows
 * the template's auto policy exactly like CLI `syntaur start`.
 */
export function resolveStartAgentOverride(
  override: string | null,
  defaultAgentId: string | null,
): string | undefined {
  if (!override || override === defaultAgentId) return undefined;
  return override;
}
