import { useEffect, useMemo, useState } from 'react';
import { Plus, Workflow, Table2, AlertTriangle, Maximize2, Minimize2, X } from 'lucide-react';
import { cn } from '../lib/utils';
import { SectionCard } from '../components/SectionCard';
import {
  defaultTransitions,
  deriveGraph,
  makeTransitionRowKey,
  toEditableTransitions,
  validateTransitions,
  collectTransitionIssues,
  type EditableTransition,
  type StatusOption,
  type TransitionIssue,
} from './transitions-helpers';
import { TransitionsGraph } from './TransitionsGraph';
import { TransitionsTable } from './TransitionsTable';
import { TransitionInspector } from './TransitionInspector';

type ViewMode = 'graph' | 'table';

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

function ViewToggle({ value, onChange }: { value: ViewMode; onChange: (v: ViewMode) => void }) {
  const options: Array<{ id: ViewMode; label: string; Icon: typeof Workflow }> = [
    { id: 'table', label: 'Table', Icon: Table2 },
    { id: 'graph', label: 'Graph', Icon: Workflow },
  ];
  return (
    <div
      role="tablist"
      aria-label="Transitions view"
      className="inline-flex rounded-md border border-border/70 bg-card/80 p-0.5"
    >
      {options.map(({ id, label, Icon }) => {
        const active = value === id;
        return (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(id)}
            className={cn(
              'inline-flex items-center gap-1.5 rounded px-2.5 py-1 text-xs transition-colors',
              active ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            <Icon className="h-3.5 w-3.5" />
            {label}
          </button>
        );
      })}
    </div>
  );
}

function Legend() {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
      <span className="inline-flex items-center gap-1">
        <span className="inline-block h-0.5 w-4 rounded bg-muted-foreground" />
        forward
      </span>
      <span className="inline-flex items-center gap-1">
        <span
          className="inline-block h-0.5 w-4 rounded"
          style={{ backgroundColor: 'oklch(var(--warning-foreground))' }}
        />
        exception (fail / block)
      </span>
      <span className="inline-flex items-center gap-1">
        <span className="inline-block h-0 w-4 border-t border-dashed border-muted-foreground" />
        recovery (reopen / unblock)
      </span>
      <span className="inline-flex items-center gap-1">
        <span
          className="inline-block h-0.5 w-4 rounded"
          style={{ backgroundColor: 'oklch(var(--error-foreground))' }}
        />
        undefined status
      </span>
    </div>
  );
}

/** Collapsible "N issues" affordance — muted at rest, lists/navigates problems. */
function IssuesChip({
  issues,
  open,
  onToggle,
  onNavigate,
}: {
  issues: TransitionIssue[];
  open: boolean;
  onToggle: () => void;
  onNavigate: (issue: TransitionIssue) => void;
}) {
  if (issues.length === 0) return null;
  return (
    <div className="relative">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="inline-flex items-center gap-1 rounded-md border border-warning-foreground/40 bg-warning/10 px-2 py-1 text-xs text-warning-foreground"
      >
        <AlertTriangle className="h-3.5 w-3.5" />
        {issues.length} issue{issues.length > 1 ? 's' : ''}
      </button>
      {open && (
        <div className="absolute right-0 z-20 mt-1 w-80 rounded-md border border-border/70 bg-card p-2 shadow-lg">
          <ul className="max-h-64 space-y-1 overflow-auto text-xs">
            {issues.map((issue, i) => (
              <li key={i}>
                <button
                  type="button"
                  onClick={() => onNavigate(issue)}
                  className="block w-full rounded px-2 py-1 text-left text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                  {issue.message}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
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
  const [viewMode, setViewMode] = useState<ViewMode>('table');
  const [focusNodeId, setFocusNodeId] = useState<string | null>(null);
  const [issuesOpen, setIssuesOpen] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);

  // Escape exits fullscreen (the in-overlay Exit button is the visible affordance).
  useEffect(() => {
    if (!isFullscreen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setIsFullscreen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isFullscreen]);

  // Read-only defaults: derive the editable rows from the UNFILTERED defaults so
  // undefined-status refs (the `pending` bug) and orphan statuses stay visible.
  const defaultRows = useMemo(() => toEditableTransitions(defaultTransitions()), []);
  const isReadOnlyDefaults = !customizing && value.length === 0;
  const rows = isReadOnlyDefaults ? defaultRows : value;
  const editable = !isReadOnlyDefaults;

  const graph = useMemo(() => deriveGraph(rows, statuses), [rows, statuses]);
  const issues = useMemo(() => collectTransitionIssues(rows, statuses), [rows, statuses]);
  const issuesByRowKey = useMemo(() => {
    const m = new Map<string, TransitionIssue[]>();
    for (const issue of issues) {
      if (!issue.rowKey) continue;
      const list = m.get(issue.rowKey);
      if (list) list.push(issue);
      else m.set(issue.rowKey, [issue]);
    }
    return m;
  }, [issues]);

  const problems = editable && customizing ? validateTransitions(value, statusIds) : [];
  const selected = value.find((r) => r.rowKey === selectedRowKey) ?? null;
  const firstStatus = statuses[0]?.id ?? '';

  function updateRow(next: EditableTransition) {
    onChange(value.map((r) => (r.rowKey === next.rowKey ? next : r)));
  }
  function removeRows(rowKeys: string[]) {
    const drop = new Set(rowKeys);
    onChange(value.filter((r) => !drop.has(r.rowKey)));
    if (selectedRowKey && drop.has(selectedRowKey)) setSelectedRowKey(null);
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

  function navigateToIssue(issue: TransitionIssue) {
    setIssuesOpen(false);
    if (issue.rowKey) {
      setSelectedRowKey(issue.rowKey);
    } else if (issue.statusId) {
      setViewMode('graph');
      setFocusNodeId(issue.statusId);
    }
  }

  const description = isReadOnlyDefaults
    ? 'Which commands move an assignment between statuses, as a state-machine graph. Showing the built-in defaults.'
    : 'Statuses are nodes; commands are labeled directed edges. Edit transitions in the table, or drag node-to-node in the graph.';

  return (
    <SectionCard
      title="Transitions"
      description={description}
      actions={
        <div className="flex flex-wrap items-center gap-2">
          <ViewToggle value={viewMode} onChange={setViewMode} />
          <IssuesChip
            issues={issues}
            open={issuesOpen}
            onToggle={() => setIssuesOpen((o) => !o)}
            onNavigate={navigateToIssue}
          />
          {viewMode === 'graph' && (
            <button
              type="button"
              onClick={() => setIsFullscreen((f) => !f)}
              aria-pressed={isFullscreen}
              title={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
              className="shell-action text-xs inline-flex items-center gap-1"
            >
              {isFullscreen ? <Minimize2 className="h-3 w-3" /> : <Maximize2 className="h-3 w-3" />}
              {isFullscreen ? 'Exit' : 'Fullscreen'}
            </button>
          )}
          {isReadOnlyDefaults ? (
            <button type="button" onClick={onCustomize} disabled={disabled} className="shell-action text-xs">
              Customize defaults
            </button>
          ) : (
            viewMode === 'graph' && (
              <button
                type="button"
                onClick={() => addRow(firstStatus, firstStatus)}
                disabled={disabled || statuses.length === 0}
                className="shell-action text-xs inline-flex items-center gap-1 disabled:opacity-50"
              >
                <Plus className="h-3 w-3" />
                Add transition
              </button>
            )
          )}
        </div>
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

      {viewMode === 'table' ? (
        <TransitionsTable
          value={rows}
          statuses={statuses}
          knownCommands={knownCommands}
          selectedRowKey={selectedRowKey}
          editable={editable}
          issuesByRowKey={issuesByRowKey}
          onChange={onChange}
          onSelectRow={setSelectedRowKey}
          disabled={disabled}
        />
      ) : (
        <div className={cn(isFullscreen ? 'fixed inset-0 z-50 flex flex-col gap-2 bg-background p-4' : 'space-y-3')}>
          <div className="flex items-center justify-between gap-2">
            <Legend />
            {isFullscreen && (
              <button
                type="button"
                onClick={() => setIsFullscreen(false)}
                className="shell-action text-xs inline-flex items-center gap-1"
              >
                <Minimize2 className="h-3 w-3" />
                Exit fullscreen
              </button>
            )}
          </div>
          <div className={cn('relative w-full', isFullscreen ? 'min-h-0 flex-1' : 'h-[72vh] min-h-[520px]')}>
            <TransitionsGraph
              nodes={graph.nodes}
              edges={graph.edges}
              statuses={statuses}
              selectedRowKey={selectedRowKey}
              focusNodeId={focusNodeId}
              editable={editable && !disabled}
              onSelectEdge={setSelectedRowKey}
              onFocusNode={setFocusNodeId}
              onCreateEdge={addRow}
              onDeleteEdge={removeRows}
            />
            {editable && selected && (
              <div className="absolute right-3 top-3 z-10 w-80 max-w-[calc(100%-1.5rem)]">
                <div className="relative">
                  <button
                    type="button"
                    onClick={() => setSelectedRowKey(null)}
                    aria-label="Close inspector"
                    className="absolute -right-1 -top-1 z-10 inline-flex h-6 w-6 items-center justify-center rounded-full border border-border/70 bg-card text-muted-foreground shadow hover:text-foreground"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                  <TransitionInspector
                    transition={selected}
                    statuses={statuses}
                    knownCommands={knownCommands}
                    onChange={updateRow}
                    onDelete={(rk) => removeRows([rk])}
                    disabled={disabled}
                  />
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </SectionCard>
  );
}
