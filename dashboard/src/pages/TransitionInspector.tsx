import { useEffect, useRef } from 'react';
import { Trash2 } from 'lucide-react';
import type { EditableTransition, StatusOption } from './transitions-helpers';
import {
  CommandDatalist,
  CommandInput,
  RequiresReasonSwitch,
  StatusSelect,
  fieldInputClass,
} from './transition-fields';

export interface TransitionInspectorProps {
  transition: EditableTransition | null;
  statuses: StatusOption[];
  knownCommands: string[];
  onChange: (next: EditableTransition) => void;
  onDelete: (rowKey: string) => void;
  disabled?: boolean;
}

const COMMANDS_LIST_ID = 'transition-inspector-commands';

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
        <StatusSelect
          value={t.from}
          onChange={(from) => patch({ from })}
          statuses={statuses}
          ariaLabel="From status"
          disabled={disabled}
          inputRef={fromRef}
          className="w-full"
        />
        {fromUndefined && (
          <span className="block text-[11px] text-error-foreground">
            “{t.from}” is not a defined status
          </span>
        )}
      </label>

      <label className="block space-y-1">
        <span className="text-xs font-medium text-muted-foreground">Command</span>
        <CommandInput
          value={t.command}
          onChange={(command) => patch({ command })}
          listId={COMMANDS_LIST_ID}
          disabled={disabled}
          className="w-full"
        />
      </label>

      <label className="block space-y-1">
        <span className="text-xs font-medium text-muted-foreground">To status</span>
        <StatusSelect
          value={t.to}
          onChange={(to) => patch({ to })}
          statuses={statuses}
          ariaLabel="To status"
          disabled={disabled}
          className="w-full"
        />
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
          className={`${fieldInputClass} w-full`}
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
          className={`${fieldInputClass} w-full resize-y`}
        />
      </label>

      <label className="flex items-center gap-2 text-xs text-muted-foreground">
        <RequiresReasonSwitch
          checked={t.requiresReason}
          onChange={(requiresReason) => patch({ requiresReason })}
          disabled={disabled}
        />
        Requires a reason
      </label>

      <CommandDatalist id={COMMANDS_LIST_ID} commands={knownCommands} />
    </div>
  );
}
