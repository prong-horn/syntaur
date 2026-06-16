import { useEffect, useRef } from 'react';
import { Trash2 } from 'lucide-react';
import type { EditableTransition, StatusOption } from './transitions-helpers';

export interface TransitionInspectorProps {
  transition: EditableTransition | null;
  statuses: StatusOption[];
  knownCommands: string[];
  onChange: (next: EditableTransition) => void;
  onDelete: (rowKey: string) => void;
  disabled?: boolean;
}

const inputClass =
  'rounded-md border border-border/60 bg-background px-2 py-1 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/30 disabled:opacity-60';

export function TransitionInspector({
  transition,
  statuses,
  knownCommands,
  onChange,
  onDelete,
  disabled,
}: TransitionInspectorProps) {
  const fromRef = useRef<HTMLSelectElement>(null);

  // Focus the first field when the selected transition changes (incl. a
  // just-added row), so the keyboard "Add transition" path lands in the editor.
  useEffect(() => {
    if (transition && !disabled) fromRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transition?.rowKey]);

  if (!transition) {
    return (
      <div className="surface-panel flex h-full min-h-[120px] items-center justify-center px-4 py-6 text-center text-xs text-muted-foreground">
        Select a transition edge to edit it, or use “Add transition”.
      </div>
    );
  }

  const t = transition;
  const statusIds = new Set(statuses.map((s) => s.id));
  const fromUndefined = !statusIds.has(t.from);
  const toUndefined = !statusIds.has(t.to);

  function patch(p: Partial<EditableTransition>) {
    onChange({ ...t, ...p });
  }

  function statusSelect(
    value: string,
    onPick: (id: string) => void,
    ariaLabel: string,
    ref?: React.Ref<HTMLSelectElement>,
  ) {
    const known = statusIds.has(value);
    return (
      <select
        ref={ref}
        value={value}
        onChange={(e) => onPick(e.target.value)}
        disabled={disabled}
        aria-label={ariaLabel}
        className={`${inputClass} w-full font-mono`}
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

  return (
    <div className="surface-panel space-y-3 px-4 py-3">
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-semibold text-foreground">Edit transition</h4>
        <button
          type="button"
          onClick={() => onDelete(t.rowKey)}
          disabled={disabled}
          className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-error-foreground hover:bg-error/10"
          aria-label="Delete transition"
        >
          <Trash2 className="h-3.5 w-3.5" />
          Delete
        </button>
      </div>

      <label className="block space-y-1">
        <span className="text-xs font-medium text-muted-foreground">From status</span>
        {statusSelect(t.from, (from) => patch({ from }), 'From status', fromRef)}
        {fromUndefined && (
          <span className="block text-[11px] text-error-foreground">
            “{t.from}” is not a defined status
          </span>
        )}
      </label>

      <label className="block space-y-1">
        <span className="text-xs font-medium text-muted-foreground">Command</span>
        <input
          type="text"
          list="transition-inspector-commands"
          value={t.command}
          onChange={(e) => patch({ command: e.target.value })}
          disabled={disabled}
          placeholder="command"
          className={`${inputClass} w-full font-mono`}
        />
      </label>

      <label className="block space-y-1">
        <span className="text-xs font-medium text-muted-foreground">To status</span>
        {statusSelect(t.to, (to) => patch({ to }), 'To status')}
        {toUndefined && (
          <span className="block text-[11px] text-error-foreground">
            “{t.to}” is not a defined status
          </span>
        )}
      </label>

      <label className="block space-y-1">
        <span className="text-xs font-medium text-muted-foreground">Label (optional)</span>
        <input
          type="text"
          value={t.label}
          onChange={(e) => patch({ label: e.target.value })}
          disabled={disabled}
          placeholder="label"
          className={`${inputClass} w-full`}
        />
      </label>

      <label className="block space-y-1">
        <span className="text-xs font-medium text-muted-foreground">Description (optional)</span>
        <textarea
          value={t.description}
          onChange={(e) => patch({ description: e.target.value })}
          disabled={disabled}
          placeholder="description"
          rows={2}
          className={`${inputClass} w-full resize-y`}
        />
      </label>

      <label className="flex items-center gap-2 text-xs text-muted-foreground">
        <button
          type="button"
          role="switch"
          aria-checked={t.requiresReason}
          aria-label="Requires reason"
          onClick={() => patch({ requiresReason: !t.requiresReason })}
          disabled={disabled}
          className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors ${
            t.requiresReason ? 'bg-primary' : 'bg-muted'
          }`}
        >
          <span
            className={`pointer-events-none inline-block h-4 w-4 rounded-full bg-background shadow-sm transition-transform ${
              t.requiresReason ? 'translate-x-4' : 'translate-x-0'
            }`}
          />
        </button>
        Requires a reason
      </label>

      <datalist id="transition-inspector-commands">
        {knownCommands.map((c) => (
          <option key={c} value={c} />
        ))}
      </datalist>
    </div>
  );
}
