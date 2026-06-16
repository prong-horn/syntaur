import { useMemo, useState } from 'react';
import { Plus } from 'lucide-react';
import { SectionCard } from '../components/SectionCard';
import {
  defaultTransitions,
  deriveGraph,
  makeTransitionRowKey,
  toEditableTransitions,
  validateTransitions,
  type EditableTransition,
  type StatusOption,
} from './transitions-helpers';
import { TransitionsGraph } from './TransitionsGraph';
import { TransitionInspector } from './TransitionInspector';

interface TransitionsSectionProps {
  value: EditableTransition[];
  /** When false (and value empty), shows the built-in defaults read-only. */
  customizing: boolean;
  statuses: StatusOption[];
  knownCommands: string[];
  onChange: (next: EditableTransition[]) => void;
  /** Seed editing from the (filtered) built-in defaults. */
  onCustomize: () => void;
  disabled?: boolean;
}

function Legend() {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
      <span className="inline-flex items-center gap-1">
        <span
          className="inline-block h-2.5 w-4 rounded"
          style={{ backgroundColor: 'oklch(var(--error-foreground))' }}
        />
        references an undefined status
      </span>
      <span className="inline-flex items-center gap-1">
        <span className="inline-block h-2.5 w-2.5 rounded-full border-2 border-dashed border-error-foreground/70" />
        ghost (undefined) status
      </span>
      <span className="inline-flex items-center gap-1">
        <span className="inline-block h-2.5 w-2.5 rounded-sm border border-warning-foreground/70 bg-warning/10" />
        orphan status (no incoming edge)
      </span>
    </div>
  );
}

export function TransitionsSection({
  value,
  customizing,
  statuses,
  knownCommands,
  onChange,
  onCustomize,
  disabled,
}: TransitionsSectionProps) {
  const statusIds = useMemo(() => new Set(statuses.map((s) => s.id)), [statuses]);
  const [selectedRowKey, setSelectedRowKey] = useState<string | null>(null);

  // Derive the read-only default graph from the UNFILTERED defaults so
  // undefined-status refs (the `pending` bug) and orphan statuses are visibly
  // flagged rather than silently dropped. `defaultTransitions()` is wire-shape,
  // so wrap it; memoize so rowKeys (React/edge keys) stay stable across renders.
  const defaultRows = useMemo(() => toEditableTransitions(defaultTransitions()), []);
  const readOnlyGraph = useMemo(() => deriveGraph(defaultRows, statuses), [defaultRows, statuses]);

  // ── read-only defaults view ────────────────────────────────────────────
  if (!customizing && value.length === 0) {
    return (
      <SectionCard
        title="Transitions"
        description="Which commands move an assignment between statuses, as a state-machine graph. Showing the built-in defaults."
        actions={
          <button type="button" onClick={onCustomize} disabled={disabled} className="shell-action text-xs">
            Customize defaults
          </button>
        }
      >
        <Legend />
        <TransitionsGraph
          nodes={readOnlyGraph.nodes}
          edges={readOnlyGraph.edges}
          selectedRowKey={null}
          editable={false}
          onSelectEdge={() => {}}
          onCreateEdge={() => {}}
          onDeleteEdge={() => {}}
        />
      </SectionCard>
    );
  }

  // ── editable view ──────────────────────────────────────────────────────
  const problems = validateTransitions(value, statusIds);
  const graph = deriveGraph(value, statuses);
  const selected = value.find((r) => r.rowKey === selectedRowKey) ?? null;

  function updateRow(next: EditableTransition) {
    onChange(value.map((r) => (r.rowKey === next.rowKey ? next : r)));
  }
  function removeRow(rowKey: string) {
    onChange(value.filter((r) => r.rowKey !== rowKey));
    if (selectedRowKey === rowKey) setSelectedRowKey(null);
  }
  function addRow(from: string, to: string) {
    const row: EditableTransition = {
      rowKey: makeTransitionRowKey(),
      from,
      command: knownCommands[0] ?? '',
      to,
      label: '',
      description: '',
      requiresReason: false,
    };
    onChange([...value, row]);
    setSelectedRowKey(row.rowKey);
  }

  const firstStatus = statuses[0]?.id ?? '';

  return (
    <SectionCard
      title="Transitions"
      description="Statuses are nodes; commands are labeled directed edges. Drag node-to-node to add a transition, or use “Add transition”, then edit it in the panel."
      actions={
        <button
          type="button"
          onClick={() => addRow(firstStatus, firstStatus)}
          disabled={disabled || statuses.length === 0}
          className="shell-action text-xs inline-flex items-center gap-1 disabled:opacity-50"
        >
          <Plus className="h-3 w-3" />
          Add transition
        </button>
      }
    >
      {problems.length > 0 && (
        <div className="mb-3 rounded-md border border-error-foreground/30 bg-error/10 px-3 py-2 text-xs text-error-foreground">
          <p className="font-medium">These transitions won't save until fixed:</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-4">
            {problems.map((p, i) => (
              <li key={i}>{p}</li>
            ))}
          </ul>
        </div>
      )}

      <Legend />

      <div className="flex flex-col gap-3 lg:flex-row">
        <div className="min-w-0 flex-1">
          <TransitionsGraph
            nodes={graph.nodes}
            edges={graph.edges}
            selectedRowKey={selectedRowKey}
            editable={!disabled}
            onSelectEdge={setSelectedRowKey}
            onCreateEdge={addRow}
            onDeleteEdge={removeRow}
          />
        </div>
        <div className="w-full shrink-0 lg:w-80">
          <TransitionInspector
            transition={selected}
            statuses={statuses}
            knownCommands={knownCommands}
            onChange={updateRow}
            onDelete={removeRow}
            disabled={disabled}
          />
        </div>
      </div>
    </SectionCard>
  );
}
