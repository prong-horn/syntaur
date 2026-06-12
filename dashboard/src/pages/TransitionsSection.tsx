import { useMemo, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { SectionCard } from '../components/SectionCard';
import {
  defaultTransitions,
  filterToStatuses,
  groupTransitions,
  makeTransitionRowKey,
  validateTransitions,
  type EditableTransition,
} from './transitions-helpers';

interface StatusOption {
  id: string;
  label: string;
}

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
  const labelFor = useMemo(() => {
    const m = new Map(statuses.map((s) => [s.id, s.label]));
    return (id: string) => m.get(id) ?? id;
  }, [statuses]);

  const [addStatusPick, setAddStatusPick] = useState('');

  const selectClass =
    'rounded-md border border-border/60 bg-background px-2 py-1 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/30 disabled:opacity-60';

  // ── read-only defaults view ────────────────────────────────────────────
  if (!customizing && value.length === 0) {
    const defaults = filterToStatuses(defaultTransitions(), statusIds);
    const groups = groupTransitions(defaults);
    return (
      <SectionCard
        title="Transitions"
        description="Which commands move an assignment between statuses. Showing the built-in defaults."
        actions={
          <button type="button" onClick={onCustomize} disabled={disabled} className="shell-action text-xs">
            Customize defaults
          </button>
        }
      >
        {groups.length === 0 ? (
          <p className="text-sm italic text-muted-foreground">
            No built-in transitions apply to the current statuses.
          </p>
        ) : (
          <div className="space-y-3">
            {groups.map((g) => (
              <div key={g.from} className="surface-panel px-3 py-2">
                <h4 className="mb-1 text-xs font-semibold text-foreground">{labelFor(g.from)}</h4>
                <ul className="space-y-0.5 font-mono text-xs text-muted-foreground">
                  {g.rows.map((r, i) => (
                    <li key={i}>
                      {r.command} → {labelFor(r.to)} <span className="opacity-60">({r.to})</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </SectionCard>
    );
  }

  // ── editable view ──────────────────────────────────────────────────────
  const problems = validateTransitions(value, statusIds);
  const groups = groupTransitions(value);
  const statusesWithoutRules = statuses.filter((s) => !groups.some((g) => g.from === s.id));

  function updateRow(rowKey: string, patch: Partial<EditableTransition>) {
    onChange(value.map((r) => (r.rowKey === rowKey ? { ...r, ...patch } : r)));
  }
  function removeRow(rowKey: string) {
    onChange(value.filter((r) => r.rowKey !== rowKey));
  }
  function addRow(from: string) {
    const row: EditableTransition = {
      rowKey: makeTransitionRowKey(),
      from,
      command: knownCommands[0] ?? '',
      to: statuses[0]?.id ?? '',
      label: '',
      description: '',
      requiresReason: false,
    };
    onChange([...value, row]);
  }
  function addStatusCard() {
    if (!addStatusPick) return;
    addRow(addStatusPick);
    setAddStatusPick('');
  }

  return (
    <SectionCard
      title="Transitions"
      description="Which commands move an assignment between statuses, grouped by the from-status."
    >
      {problems.length > 0 && (
        <div className="mb-3 rounded-md border border-error-foreground/30 bg-error/10 px-3 py-2 text-xs text-error-foreground">
          <p className="font-medium">These transitions won't save until fixed:</p>
          <ul className="mt-1 list-disc pl-4 space-y-0.5">
            {problems.map((p, i) => (
              <li key={i}>{p}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="space-y-3">
        {groups.map((g) => (
          <div key={g.from} className="surface-panel px-3 py-2">
            <h4 className="mb-2 text-xs font-semibold text-foreground">
              {labelFor(g.from)} <span className="font-mono text-muted-foreground">({g.from})</span>
            </h4>
            <div className="space-y-2">
              {g.rows.map((r) => (
                <div key={r.rowKey} className="flex flex-wrap items-center gap-1.5">
                  <input
                    type="text"
                    list="transition-command-names"
                    value={r.command}
                    onChange={(e) => updateRow(r.rowKey, { command: e.target.value })}
                    disabled={disabled}
                    placeholder="command"
                    className={`${selectClass} w-28 font-mono`}
                  />
                  <span className="text-muted-foreground">→</span>
                  <select
                    value={r.to}
                    onChange={(e) => updateRow(r.rowKey, { to: e.target.value })}
                    disabled={disabled}
                    aria-label="Target status"
                    className={`${selectClass} font-mono`}
                  >
                    {!statusIds.has(r.to) && r.to !== '' && <option value={r.to}>{r.to}</option>}
                    {statuses.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.label} ({s.id})
                      </option>
                    ))}
                  </select>
                  <input
                    type="text"
                    value={r.label}
                    onChange={(e) => updateRow(r.rowKey, { label: e.target.value })}
                    disabled={disabled}
                    placeholder="label (optional)"
                    className={`${selectClass} w-32`}
                  />
                  <input
                    type="text"
                    value={r.description}
                    onChange={(e) => updateRow(r.rowKey, { description: e.target.value })}
                    disabled={disabled}
                    placeholder="description (optional)"
                    className={`${selectClass} w-40`}
                  />
                  <label className="flex items-center gap-1 text-xs text-muted-foreground">
                    <button
                      type="button"
                      role="switch"
                      aria-checked={r.requiresReason}
                      aria-label="Requires reason"
                      onClick={() => updateRow(r.rowKey, { requiresReason: !r.requiresReason })}
                      disabled={disabled}
                      className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors ${
                        r.requiresReason ? 'bg-primary' : 'bg-muted'
                      }`}
                    >
                      <span
                        className={`pointer-events-none inline-block h-4 w-4 rounded-full bg-background shadow-sm transition-transform ${
                          r.requiresReason ? 'translate-x-4' : 'translate-x-0'
                        }`}
                      />
                    </button>
                    needs reason
                  </label>
                  <button
                    type="button"
                    onClick={() => removeRow(r.rowKey)}
                    disabled={disabled}
                    className="ml-auto inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
                    aria-label="Remove transition"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
            </div>
            <button
              type="button"
              onClick={() => addRow(g.from)}
              disabled={disabled}
              className="mt-2 shell-action text-xs inline-flex items-center gap-1"
            >
              <Plus className="h-3 w-3" />
              Add transition
            </button>
          </div>
        ))}
      </div>

      {statusesWithoutRules.length > 0 && (
        <div className="mt-3 flex items-center gap-2">
          <select
            value={addStatusPick}
            onChange={(e) => setAddStatusPick(e.target.value)}
            disabled={disabled}
            aria-label="Add rules for status"
            className={`${selectClass} font-mono`}
          >
            <option value="">Add rules for status…</option>
            {statusesWithoutRules.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label} ({s.id})
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={addStatusCard}
            disabled={disabled || !addStatusPick}
            className="shell-action text-xs inline-flex items-center gap-1 disabled:opacity-50"
          >
            <Plus className="h-3 w-3" />
            Add status rules
          </button>
        </div>
      )}

      <datalist id="transition-command-names">
        {knownCommands.map((c) => (
          <option key={c} value={c} />
        ))}
      </datalist>
    </SectionCard>
  );
}
