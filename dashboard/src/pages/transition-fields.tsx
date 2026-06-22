import type { Ref } from 'react';
import { cn } from '../lib/utils';
import type { StatusOption } from './transitions-helpers';

// Shared field widgets for editing a transition (from / command / to /
// requires-reason). Extracted from TransitionInspector so the inspector AND the
// table cells render the exact same controls. Keep these presentational and
// controlled — no local state, no data mutation beyond the `onChange` callback.

export const fieldInputClass =
  'rounded-md border border-border/60 bg-background px-2 py-1 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/30 disabled:opacity-60';

export interface StatusSelectProps {
  value: string;
  onChange: (id: string) => void;
  statuses: StatusOption[];
  ariaLabel: string;
  disabled?: boolean;
  className?: string;
  inputRef?: Ref<HTMLSelectElement>;
}

/**
 * Status `<select>` that keeps an undefined-but-referenced value selectable
 * (rendered as "<id> (undefined)") so editing a broken transition never silently
 * drops its dangling endpoint.
 */
export function StatusSelect({
  value,
  onChange,
  statuses,
  ariaLabel,
  disabled,
  className,
  inputRef,
}: StatusSelectProps) {
  const known = statuses.some((s) => s.id === value);
  return (
    <select
      ref={inputRef}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled}
      aria-label={ariaLabel}
      className={cn(fieldInputClass, 'font-mono', className)}
    >
      {!known && value !== '' && <option value={value}>{value} (undefined)</option>}
      {value === '' && <option value="">Select a status…</option>}
      {statuses.map((s) => (
        <option key={s.id} value={s.id}>
          {s.label} ({s.id})
        </option>
      ))}
    </select>
  );
}

/**
 * One shared `<datalist>` of known commands. Render ONCE per editor surface and
 * point every {@link CommandInput}'s `listId` at its `id` (duplicate datalist ids
 * are invalid HTML, so the table renders this once, not per row).
 */
export function CommandDatalist({ id, commands }: { id: string; commands: string[] }) {
  return (
    <datalist id={id}>
      {commands.map((c) => (
        <option key={c} value={c} />
      ))}
    </datalist>
  );
}

export interface CommandInputProps {
  value: string;
  onChange: (command: string) => void;
  /** id of a {@link CommandDatalist} rendered by the parent. */
  listId: string;
  ariaLabel?: string;
  disabled?: boolean;
  className?: string;
}

export function CommandInput({
  value,
  onChange,
  listId,
  ariaLabel = 'Command',
  disabled,
  className,
}: CommandInputProps) {
  return (
    <input
      type="text"
      list={listId}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled}
      placeholder="command"
      aria-label={ariaLabel}
      className={cn(fieldInputClass, 'font-mono', className)}
    />
  );
}

export interface RequiresReasonSwitchProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  ariaLabel?: string;
}

export function RequiresReasonSwitch({
  checked,
  onChange,
  disabled,
  ariaLabel = 'Requires reason',
}: RequiresReasonSwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      onClick={() => onChange(!checked)}
      disabled={disabled}
      className={cn(
        'relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background',
        checked ? 'bg-primary' : 'bg-muted',
      )}
    >
      <span
        className={cn(
          'pointer-events-none inline-block h-4 w-4 rounded-full bg-background shadow-sm transition-transform',
          checked ? 'translate-x-4' : 'translate-x-0',
        )}
      />
    </button>
  );
}
