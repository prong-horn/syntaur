import { useState } from 'react';
import { Plus, Trash2, ChevronRight, ChevronDown, AlertTriangle } from 'lucide-react';
import { cn } from '../lib/utils';
import {
  groupTransitions,
  makeTransitionRowKey,
  type EditableTransition,
  type StatusOption,
  type TransitionIssue,
} from './transitions-helpers';
import {
  CommandDatalist,
  CommandInput,
  RequiresReasonSwitch,
  StatusSelect,
  fieldInputClass,
} from './transition-fields';

const COMMANDS_LIST_ID = 'transitions-table-commands';

export interface TransitionsTableProps {
  /** Rows to render — editable rows, or the read-only defaults when `editable` is false. */
  value: EditableTransition[];
  statuses: StatusOption[];
  knownCommands: string[];
  selectedRowKey: string | null;
  /** When false the table is a read-only view of `value` (built-in defaults). */
  editable: boolean;
  /** Per-row issues (from `collectTransitionIssues`, indexed by rowKey) for inline badges. */
  issuesByRowKey: Map<string, TransitionIssue[]>;
  onChange: (next: EditableTransition[]) => void;
  onSelectRow: (rowKey: string) => void;
  disabled?: boolean;
}

/**
 * Primary authoring surface for transitions: a compact editor grouped by `from`
 * status. Each row edits from/command/to/requires-reason inline, with an
 * expander revealing the optional label + description so nothing the inspector
 * could edit is lost. Selecting a row drives cross-highlight with the graph.
 * Transition order is non-semantic, so rows are not drag-reorderable (v1).
 */
export function TransitionsTable({
  value,
  statuses,
  knownCommands,
  selectedRowKey,
  editable,
  issuesByRowKey,
  onChange,
  onSelectRow,
  disabled,
}: TransitionsTableProps) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const groups = groupTransitions(value);
  const firstStatus = statuses[0]?.id ?? '';
  const readOnly = !editable || disabled;

  function updateRow(next: EditableTransition) {
    onChange(value.map((r) => (r.rowKey === next.rowKey ? next : r)));
  }
  function removeRow(rowKey: string) {
    onChange(value.filter((r) => r.rowKey !== rowKey));
  }
  function addRow(from: string) {
    const row: EditableTransition = {
      rowKey: makeTransitionRowKey(),
      from: from || firstStatus,
      command: knownCommands[0] ?? '',
      to: firstStatus,
      label: '',
      description: '',
      requiresReason: false,
    };
    onChange([...value, row]);
    onSelectRow(row.rowKey);
    setExpanded((prev) => new Set(prev).add(row.rowKey));
  }
  function toggleExpanded(rowKey: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(rowKey)) next.delete(rowKey);
      else next.add(rowKey);
      return next;
    });
  }

  if (value.length === 0) {
    return (
      <div className="space-y-3">
        <p className="surface-panel px-4 py-6 text-center text-sm text-muted-foreground">
          No transitions defined yet.
        </p>
        {editable && !disabled && (
          <button
            type="button"
            onClick={() => addRow(firstStatus)}
            disabled={statuses.length === 0}
            className="shell-action text-xs inline-flex items-center gap-1 disabled:opacity-50"
          >
            <Plus className="h-3 w-3" />
            Add transition
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {groups.map((group) => {
        const fromStatus = statuses.find((s) => s.id === group.from);
        return (
          <div key={group.from} className="space-y-2">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                <span
                  className="inline-block h-2.5 w-2.5 shrink-0 rounded-full border border-border/50"
                  style={fromStatus?.color ? { backgroundColor: fromStatus.color } : undefined}
                />
                <span className="text-foreground">{fromStatus?.label ?? group.from}</span>
                <span className="font-mono text-[10px] text-muted-foreground">{group.from}</span>
              </div>
              {!readOnly && (
                <button
                  type="button"
                  onClick={() => addRow(group.from)}
                  className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
                  aria-label={`Add transition from ${group.from}`}
                >
                  <Plus className="h-3 w-3" />
                  Add
                </button>
              )}
            </div>

            <div className="space-y-2">
              {group.rows.map((r) => {
                const issues = issuesByRowKey.get(r.rowKey) ?? [];
                const isExpanded = expanded.has(r.rowKey);
                const isSelected = r.rowKey === selectedRowKey;
                return (
                  <div
                    key={r.rowKey}
                    onClick={() => onSelectRow(r.rowKey)}
                    className={cn(
                      'surface-panel px-3 py-2 transition-colors',
                      isSelected && 'ring-2 ring-primary/50',
                    )}
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleExpanded(r.rowKey);
                        }}
                        aria-label={isExpanded ? 'Collapse row' : 'Expand row (label & description)'}
                        aria-expanded={isExpanded}
                        className="text-muted-foreground/60 hover:text-muted-foreground"
                      >
                        {isExpanded ? (
                          <ChevronDown className="h-4 w-4" />
                        ) : (
                          <ChevronRight className="h-4 w-4" />
                        )}
                      </button>

                      <StatusSelect
                        value={r.from}
                        onChange={(from) => updateRow({ ...r, from })}
                        statuses={statuses}
                        ariaLabel="From status"
                        disabled={readOnly}
                        className="min-w-[8rem] flex-1"
                      />
                      <span className="text-muted-foreground" aria-hidden>
                        —
                      </span>
                      <CommandInput
                        value={r.command}
                        onChange={(command) => updateRow({ ...r, command })}
                        listId={COMMANDS_LIST_ID}
                        disabled={readOnly}
                        className="min-w-[7rem] flex-1"
                      />
                      <span className="text-muted-foreground" aria-hidden>
                        →
                      </span>
                      <StatusSelect
                        value={r.to}
                        onChange={(to) => updateRow({ ...r, to })}
                        statuses={statuses}
                        ariaLabel="To status"
                        disabled={readOnly}
                        className="min-w-[8rem] flex-1"
                      />

                      <label
                        className="flex items-center gap-1.5 text-[11px] text-muted-foreground"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <RequiresReasonSwitch
                          checked={r.requiresReason}
                          onChange={(requiresReason) => updateRow({ ...r, requiresReason })}
                          disabled={readOnly}
                        />
                        reason
                      </label>

                      {issues.length > 0 && (
                        <span
                          className="inline-flex items-center text-warning-foreground"
                          title={issues.map((i) => i.message).join('\n')}
                          aria-label={`${issues.length} issue${issues.length > 1 ? 's' : ''}`}
                        >
                          <AlertTriangle className="h-3.5 w-3.5" />
                        </span>
                      )}

                      {!readOnly && (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            removeRow(r.rowKey);
                          }}
                          className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-error/10 hover:text-error-foreground"
                          aria-label="Remove transition"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </div>

                    {isExpanded && (
                      <div className="mt-2 grid gap-2 pl-6 sm:grid-cols-2" onClick={(e) => e.stopPropagation()}>
                        <label className="block space-y-1">
                          <span className="text-[11px] font-medium text-muted-foreground">Label (optional)</span>
                          <input
                            type="text"
                            value={r.label}
                            onChange={(e) => updateRow({ ...r, label: e.target.value })}
                            disabled={readOnly}
                            placeholder="label"
                            className={cn(fieldInputClass, 'w-full')}
                          />
                        </label>
                        <label className="block space-y-1">
                          <span className="text-[11px] font-medium text-muted-foreground">Description (optional)</span>
                          <input
                            type="text"
                            value={r.description}
                            onChange={(e) => updateRow({ ...r, description: e.target.value })}
                            disabled={readOnly}
                            placeholder="description"
                            className={cn(fieldInputClass, 'w-full')}
                          />
                        </label>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}

      {editable && !disabled && (
        <button
          type="button"
          onClick={() => addRow(firstStatus)}
          disabled={statuses.length === 0}
          className="shell-action text-xs inline-flex items-center gap-1 disabled:opacity-50"
        >
          <Plus className="h-3 w-3" />
          Add transition
        </button>
      )}

      <CommandDatalist id={COMMANDS_LIST_ID} commands={knownCommands} />
    </div>
  );
}
