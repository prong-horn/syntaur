import { useState, useEffect, useMemo, useRef } from 'react';
import { Plus, Trash2, Code2, ListTree } from 'lucide-react';
import type { FieldRegistry } from '@shared/query';
import {
  whenToBuilderModel,
  builderModelToString,
  validateCondition,
  opsForKind,
  type BuilderModel,
  type BuilderComparison,
  type BuilderOp,
  type FieldOption,
} from './condition-editor-helpers';

interface ConditionEditorProps {
  value: string;
  onChange: (next: string) => void;
  /** Field vocabulary (camelCase + kind) for autocomplete and op selection. */
  fieldOptions: FieldOption[];
  /** Registry the condition validates against (built-ins + accepted facts). */
  registry: FieldRegistry;
  disabled?: boolean;
}

function emptyModel(fields: FieldOption[]): BuilderModel {
  const first = fields[0];
  const comparison: BuilderComparison = first
    ? { field: first.name, op: opsForKind(first.kind)[0], value: first.kind === 'bool' ? 'true' : '' }
    : { field: '', op: ':', value: '' };
  return { outerJoin: 'AND', groups: [{ join: 'AND', comparisons: [comparison] }] };
}

/**
 * Dual-mode AQL condition editor. The `value` string is the single source of
 * truth; the structured builder is a lossless view of the supported subgrammar.
 * Conditions too complex for the builder force raw mode (toggle disabled) and
 * are never flattened. See condition-editor-helpers for the grammar.
 */
export function ConditionEditor({ value, onChange, fieldOptions, registry, disabled }: ConditionEditorProps) {
  const builderFromValue = useMemo(() => whenToBuilderModel(value), [value]);
  const builderEligible = value.trim() === '' || builderFromValue !== null;

  const [mode, setMode] = useState<'builder' | 'raw'>(builderEligible ? 'builder' : 'raw');
  const [model, setModel] = useState<BuilderModel>(() => builderFromValue ?? emptyModel(fieldOptions));
  const lastEmitted = useRef(value);

  // Resync the builder model when `value` changes from OUTSIDE our own edits
  // (e.g. a parent reset / mode-switch echo). Our own edits set lastEmitted so
  // the round-tripped value is ignored here, avoiding clobbering mid-edit.
  useEffect(() => {
    if (value === lastEmitted.current) return;
    const m = whenToBuilderModel(value);
    if (m) setModel(m);
    if (!(value.trim() === '' || m) && mode === 'builder') setMode('raw');
    lastEmitted.current = value;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const error = validateCondition(value, registry);

  function emit(next: string) {
    lastEmitted.current = next;
    onChange(next);
  }

  function commitModel(next: BuilderModel) {
    setModel(next);
    emit(builderModelToString(next));
  }

  // ── builder mutations ──────────────────────────────────────────────────
  function setOuterJoin(join: 'AND' | 'OR') {
    commitModel({ outerJoin: join, groups: model.groups.map((g) => ({ ...g, join: join === 'AND' ? 'OR' : 'AND' })) });
  }
  function updateComparison(gi: number, ci: number, patch: Partial<BuilderComparison>) {
    const groups = model.groups.map((g, i) =>
      i === gi
        ? { ...g, comparisons: g.comparisons.map((c, j) => (j === ci ? { ...c, ...patch } : c)) }
        : g,
    );
    commitModel({ ...model, groups });
  }
  function addComparison(gi: number) {
    const fallback = emptyModel(fieldOptions).groups[0].comparisons[0];
    const groups = model.groups.map((g, i) =>
      i === gi ? { ...g, comparisons: [...g.comparisons, { ...fallback }] } : g,
    );
    commitModel({ ...model, groups });
  }
  function removeComparison(gi: number, ci: number) {
    let groups = model.groups.map((g, i) =>
      i === gi ? { ...g, comparisons: g.comparisons.filter((_, j) => j !== ci) } : g,
    );
    groups = groups.filter((g) => g.comparisons.length > 0);
    if (groups.length === 0) groups = emptyModel(fieldOptions).groups;
    commitModel({ ...model, groups });
  }
  function addGroup() {
    const innerJoin = model.outerJoin === 'AND' ? 'OR' : 'AND';
    commitModel({ ...model, groups: [...model.groups, { join: innerJoin, comparisons: [emptyModel(fieldOptions).groups[0].comparisons[0]] }] });
  }

  function toggleMode() {
    if (mode === 'builder') {
      setMode('raw');
      return;
    }
    // raw → builder only when the current string is representable.
    if (builderEligible) {
      setModel(builderFromValue ?? emptyModel(fieldOptions));
      setMode('builder');
    }
  }

  const inputClass =
    'rounded-md border border-border/60 bg-background px-2 py-1 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/30 disabled:opacity-60';

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">Condition</span>
        <button
          type="button"
          onClick={toggleMode}
          disabled={disabled || (mode === 'raw' && !builderEligible)}
          title={
            mode === 'raw' && !builderEligible
              ? 'Condition too complex for the builder — edit as raw AQL'
              : mode === 'builder'
                ? 'Switch to raw AQL'
                : 'Switch to builder'
          }
          className="shell-action text-xs inline-flex items-center gap-1 disabled:opacity-50"
        >
          {mode === 'builder' ? <Code2 className="h-3 w-3" /> : <ListTree className="h-3 w-3" />}
          {mode === 'builder' ? 'Raw AQL' : 'Builder'}
        </button>
      </div>

      {mode === 'raw' ? (
        <input
          type="text"
          list="aql-field-names"
          value={value}
          onChange={(e) => emit(e.target.value)}
          disabled={disabled}
          placeholder="e.g. planApproved:true AND implementationStarted:true"
          className={`${inputClass} w-full font-mono`}
        />
      ) : (
        <div className="space-y-2">
          {model.groups.map((group, gi) => (
            <div key={gi}>
              {gi > 0 && (
                <div className="my-1 flex items-center gap-2">
                  <span className="h-px flex-1 bg-border/60" />
                  <button
                    type="button"
                    onClick={() => setOuterJoin(model.outerJoin === 'AND' ? 'OR' : 'AND')}
                    disabled={disabled}
                    className="shell-action text-[10px] uppercase tracking-wide"
                  >
                    {model.outerJoin}
                  </button>
                  <span className="h-px flex-1 bg-border/60" />
                </div>
              )}
              <div className="rounded-md border border-border/50 bg-background/60 p-2 space-y-1.5">
                {group.comparisons.map((c, ci) => {
                  const fieldDef = fieldOptions.find((f) => f.name === c.field);
                  const kind = fieldDef?.kind ?? 'string';
                  const ops = opsForKind(kind);
                  return (
                    <div key={ci} className="flex items-center gap-1.5">
                      {ci > 0 && (
                        <span className="w-9 shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground">
                          {group.join}
                        </span>
                      )}
                      <select
                        value={c.field}
                        onChange={(e) => {
                          const nextField = fieldOptions.find((f) => f.name === e.target.value);
                          const nextKind = nextField?.kind ?? 'string';
                          const nextOps = opsForKind(nextKind);
                          updateComparison(gi, ci, {
                            field: e.target.value,
                            op: nextOps.includes(c.op) ? c.op : nextOps[0],
                            value: nextKind === 'bool' ? 'true' : c.value,
                          });
                        }}
                        disabled={disabled}
                        className={`${inputClass} font-mono`}
                      >
                        {fieldOptions.length === 0 && <option value="">(no fields)</option>}
                        {/* keep an unknown field selectable so we never lose the user's value */}
                        {!fieldOptions.some((f) => f.name === c.field) && c.field !== '' && (
                          <option value={c.field}>{c.field}</option>
                        )}
                        {fieldOptions.map((f) => (
                          <option key={f.name} value={f.name}>
                            {f.name}
                          </option>
                        ))}
                      </select>
                      <select
                        value={c.op}
                        onChange={(e) => updateComparison(gi, ci, { op: e.target.value as BuilderOp })}
                        disabled={disabled}
                        className={`${inputClass} font-mono`}
                      >
                        {ops.map((op) => (
                          <option key={op} value={op}>
                            {op}
                          </option>
                        ))}
                      </select>
                      {kind === 'bool' ? (
                        <select
                          value={c.value || 'true'}
                          onChange={(e) => updateComparison(gi, ci, { value: e.target.value })}
                          disabled={disabled}
                          className={`${inputClass} font-mono`}
                        >
                          <option value="true">true</option>
                          <option value="false">false</option>
                        </select>
                      ) : (
                        <input
                          type="text"
                          value={c.value}
                          onChange={(e) => updateComparison(gi, ci, { value: e.target.value })}
                          disabled={disabled}
                          placeholder="value"
                          className={`${inputClass} w-24 font-mono`}
                        />
                      )}
                      <button
                        type="button"
                        onClick={() => removeComparison(gi, ci)}
                        disabled={disabled}
                        className="ml-auto inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
                        aria-label="Remove condition"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  );
                })}
                <button
                  type="button"
                  onClick={() => addComparison(gi)}
                  disabled={disabled}
                  className="shell-action text-xs inline-flex items-center gap-1"
                >
                  <Plus className="h-3 w-3" />
                  {group.join} condition
                </button>
              </div>
            </div>
          ))}
          <button
            type="button"
            onClick={addGroup}
            disabled={disabled}
            className="shell-action text-xs inline-flex items-center gap-1"
          >
            <Plus className="h-3 w-3" />
            {model.outerJoin} group
          </button>
        </div>
      )}

      {/* Shared field-name datalist for raw-mode autocomplete. */}
      <datalist id="aql-field-names">
        {fieldOptions.map((f) => (
          <option key={f.name} value={f.name} />
        ))}
      </datalist>

      <p className="font-mono text-[11px] text-muted-foreground truncate" title={value}>
        {value.trim() === '' ? <span className="italic">empty condition</span> : value}
      </p>
      {error && <p className="text-xs text-error-foreground">{error}</p>}
    </div>
  );
}
