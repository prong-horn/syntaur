import { useMemo, type ReactNode } from 'react';
import { Plus, Trash2, GripVertical, RotateCcw } from 'lucide-react';
import {
  DndContext,
  closestCenter,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  verticalListSortingStrategy,
  useSortable,
  arrayMove,
  sortableKeyboardCoordinates,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { SectionCard } from '../components/SectionCard';
import { ConditionEditor } from '../components/ConditionEditor';
import { deriveFieldOptions } from '../components/condition-editor-helpers';
import { buildDeriveRegistry, type FactDeclaration } from '@shared/fact-registry';
import {
  catchAllIndex,
  makeDeriveRowKey,
  validateDeriveSection,
  fromEditableDerive,
  type EditableDerive,
  type EditableRung,
  type EditableDispRule,
} from './derive-rules-helpers';

const DISPOSITIONS = ['active', 'blocked', 'parked'] as const;

interface StatusOption {
  id: string;
  label: string;
}

interface DeriveRulesSectionProps {
  value: EditableDerive;
  deriveCustom: boolean;
  statuses: StatusOption[];
  acceptedFacts: FactDeclaration[];
  onChange: (next: EditableDerive) => void;
  onReset: () => void;
  disabled?: boolean;
}

export function DeriveRulesSection({
  value,
  deriveCustom,
  statuses,
  acceptedFacts,
  onChange,
  onReset,
  disabled,
}: DeriveRulesSectionProps) {
  const registry = useMemo(() => buildDeriveRegistry(acceptedFacts), [acceptedFacts]);
  const fieldOptions = useMemo(() => deriveFieldOptions(acceptedFacts), [acceptedFacts]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const problems = useMemo(() => {
    try {
      return validateDeriveSection(fromEditableDerive(value), statuses, registry);
    } catch {
      return ['derive rules are malformed'];
    }
  }, [value, statuses, registry]);

  const caIndex = catchAllIndex(value.phaseLadder);
  const catchAll = caIndex >= 0 ? value.phaseLadder[caIndex] : null;
  const draggable = value.phaseLadder.filter((_, i) => i !== caIndex);

  // ── phase ladder mutations ─────────────────────────────────────────────
  function commitLadder(catchAllRung: EditableRung | null, others: EditableRung[]) {
    onChange({ ...value, phaseLadder: [...(catchAllRung ? [catchAllRung] : []), ...others] });
  }
  function updateRung(rowKey: string, patch: Partial<EditableRung>) {
    const next = value.phaseLadder.map((r) => (r.rowKey === rowKey ? { ...r, ...patch } : r));
    onChange({ ...value, phaseLadder: next });
  }
  function addRung() {
    const rung: EditableRung = {
      rowKey: makeDeriveRowKey(),
      phase: statuses[0]?.id ?? '',
      when: '',
      next: '',
    };
    commitLadder(catchAll, [...draggable, rung]);
  }
  function removeRung(rowKey: string) {
    onChange({ ...value, phaseLadder: value.phaseLadder.filter((r) => r.rowKey !== rowKey) });
  }
  function handleLadderDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = draggable.findIndex((r) => r.rowKey === active.id);
    const newIndex = draggable.findIndex((r) => r.rowKey === over.id);
    if (oldIndex === -1 || newIndex === -1) return;
    commitLadder(catchAll, arrayMove(draggable, oldIndex, newIndex));
  }

  // ── disposition mutations ──────────────────────────────────────────────
  function updateDisp(rowKey: string, patch: Partial<EditableDispRule>) {
    onChange({ ...value, disposition: value.disposition.map((r) => (r.rowKey === rowKey ? { ...r, ...patch } : r)) });
  }
  function addDisp() {
    const rule: EditableDispRule = { rowKey: makeDeriveRowKey(), when: '', is: 'active' };
    const elseIdx = value.disposition.findIndex((r) => r.when === null);
    const next = [...value.disposition];
    if (elseIdx >= 0) next.splice(elseIdx, 0, rule);
    else next.push(rule);
    onChange({ ...value, disposition: next });
  }
  function removeDisp(rowKey: string) {
    onChange({ ...value, disposition: value.disposition.filter((r) => r.rowKey !== rowKey) });
  }

  function updateHeadline(key: 'parked' | 'blocked', id: string) {
    onChange({ ...value, headline: { ...value.headline, [key]: id } });
  }

  const selectClass =
    'rounded-md border border-border/60 bg-background px-2 py-1 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/30 disabled:opacity-60';

  function statusSelect(current: string, onPick: (id: string) => void, ariaLabel: string) {
    return (
      <select
        value={current}
        onChange={(e) => onPick(e.target.value)}
        disabled={disabled}
        aria-label={ariaLabel}
        className={`${selectClass} font-mono`}
      >
        {!statuses.some((s) => s.id === current) && current !== '' && <option value={current}>{current}</option>}
        {statuses.map((s) => (
          <option key={s.id} value={s.id}>
            {s.label} ({s.id})
          </option>
        ))}
      </select>
    );
  }

  return (
    <SectionCard
      title="Derive Rules"
      description="The phase ladder, disposition rules, and headline projection that map facts to a status. Highest matching rung wins — drag to reorder priority."
      actions={
        deriveCustom ? (
          <button
            type="button"
            className="shell-action text-xs inline-flex items-center gap-1"
            onClick={onReset}
            disabled={disabled}
          >
            <RotateCcw className="h-3 w-3" />
            Reset to default rules
          </button>
        ) : undefined
      }
    >
      {!deriveCustom && (
        <div className="mb-3 rounded-md border border-border/60 bg-muted/30 px-3 py-1.5 text-xs text-muted-foreground">
          Using built-in derive rules. Editing anything below switches to a custom configuration.
        </div>
      )}
      {problems.length > 0 && (
        <div className="mb-3 rounded-md border border-error-foreground/30 bg-error/10 px-3 py-2 text-xs text-error-foreground">
          <p className="font-medium">These derive rules won't save until fixed:</p>
          <ul className="mt-1 list-disc pl-4 space-y-0.5">
            {problems.map((p, i) => (
              <li key={i}>{p}</li>
            ))}
          </ul>
        </div>
      )}

      {/* Phase ladder */}
      <div className="space-y-2">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Phase ladder</h4>

        {catchAll && (
          <div className="surface-panel flex flex-wrap items-start gap-3 px-3 py-2 opacity-90">
            <span className="mt-1 text-muted-foreground/40">
              <GripVertical className="h-4 w-4 opacity-30" />
            </span>
            <div className="min-w-[10rem] flex-1 space-y-1">
              <label className="text-xs text-muted-foreground">Phase (catch-all, lowest priority)</label>
              {statusSelect(catchAll.phase, (id) => updateRung(catchAll.rowKey, { phase: id }), 'Catch-all phase')}
              <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">matches everything</span>
            </div>
            <div className="min-w-[12rem] flex-1">
              <label className="text-xs text-muted-foreground">Next action</label>
              <input
                type="text"
                value={catchAll.next}
                onChange={(e) => updateRung(catchAll.rowKey, { next: e.target.value })}
                disabled={disabled}
                className={`${selectClass} w-full`}
              />
            </div>
          </div>
        )}

        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleLadderDragEnd}>
          <SortableContext items={draggable.map((r) => r.rowKey)} strategy={verticalListSortingStrategy}>
            <div className="space-y-2">
              {draggable.map((rung) => (
                <SortableRungCard
                  key={rung.rowKey}
                  rung={rung}
                  disabled={disabled}
                  statusSelect={statusSelect}
                  fieldOptions={fieldOptions}
                  registry={registry}
                  onUpdate={(patch) => updateRung(rung.rowKey, patch)}
                  onRemove={() => removeRung(rung.rowKey)}
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>

        <button type="button" onClick={addRung} disabled={disabled} className="shell-action text-xs inline-flex items-center gap-1">
          <Plus className="h-3 w-3" />
          Add rung
        </button>
      </div>

      {/* Disposition */}
      <div className="mt-5 space-y-2">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Disposition (first match wins)</h4>
        <div className="space-y-2">
          {value.disposition.map((rule) =>
            rule.when === null ? (
              <div key={rule.rowKey} className="surface-panel flex items-center gap-3 px-3 py-2">
                <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">otherwise</span>
                <span className="text-sm text-muted-foreground">is</span>
                <select
                  value={rule.is}
                  onChange={(e) => updateDisp(rule.rowKey, { is: e.target.value })}
                  disabled={disabled}
                  className={`${selectClass} font-mono`}
                >
                  {DISPOSITIONS.map((d) => (
                    <option key={d} value={d}>
                      {d}
                    </option>
                  ))}
                </select>
              </div>
            ) : (
              <div key={rule.rowKey} className="surface-panel flex flex-wrap items-start gap-3 px-3 py-2">
                <div className="min-w-[14rem] flex-1">
                  <ConditionEditor
                    value={rule.when}
                    onChange={(next) => updateDisp(rule.rowKey, { when: next })}
                    fieldOptions={fieldOptions}
                    registry={registry}
                    disabled={disabled}
                  />
                </div>
                <div className="flex items-center gap-2 pt-5">
                  <span className="text-sm text-muted-foreground">is</span>
                  <select
                    value={rule.is}
                    onChange={(e) => updateDisp(rule.rowKey, { is: e.target.value })}
                    disabled={disabled}
                    className={`${selectClass} font-mono`}
                  >
                    {DISPOSITIONS.map((d) => (
                      <option key={d} value={d}>
                        {d}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    onClick={() => removeDisp(rule.rowKey)}
                    disabled={disabled}
                    className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
                    aria-label="Remove disposition rule"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            ),
          )}
        </div>
        <button type="button" onClick={addDisp} disabled={disabled} className="shell-action text-xs inline-flex items-center gap-1">
          <Plus className="h-3 w-3" />
          Add disposition rule
        </button>
      </div>

      {/* Headline projection */}
      <div className="mt-5 space-y-2">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Headline projection</h4>
        <div className="surface-panel grid grid-cols-1 gap-3 px-3 py-2 sm:grid-cols-2">
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">When parked, show</label>
            {statusSelect(value.headline.parked, (id) => updateHeadline('parked', id), 'Parked headline status')}
          </div>
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">When blocked, show</label>
            {statusSelect(value.headline.blocked, (id) => updateHeadline('blocked', id), 'Blocked headline status')}
          </div>
          <div className="text-xs text-muted-foreground">
            Terminal statuses: <span className="font-mono">passthrough</span>
          </div>
          <div className="text-xs text-muted-foreground">
            Active: <span className="font-mono">phase</span>
          </div>
        </div>
      </div>
    </SectionCard>
  );
}

interface SortableRungCardProps {
  rung: EditableRung;
  disabled?: boolean;
  statusSelect: (current: string, onPick: (id: string) => void, ariaLabel: string) => ReactNode;
  fieldOptions: ReturnType<typeof deriveFieldOptions>;
  registry: ReturnType<typeof buildDeriveRegistry>;
  onUpdate: (patch: Partial<EditableRung>) => void;
  onRemove: () => void;
}

function SortableRungCard({ rung, disabled, statusSelect, fieldOptions, registry, onUpdate, onRemove }: SortableRungCardProps) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({
    id: rung.rowKey,
  });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    zIndex: isDragging ? 50 : undefined,
    position: isDragging ? ('relative' as const) : undefined,
  };
  return (
    <div ref={setNodeRef} style={style} className={`surface-panel flex flex-wrap items-start gap-3 px-3 py-2 ${isDragging ? 'opacity-60 shadow-lg' : ''}`}>
      <button
        ref={setActivatorNodeRef}
        {...attributes}
        {...listeners}
        type="button"
        aria-label="Drag to reorder rung"
        className="mt-1 cursor-grab active:cursor-grabbing text-muted-foreground/40 hover:text-muted-foreground transition touch-none"
      >
        <GripVertical className="h-4 w-4" />
      </button>
      <div className="min-w-[10rem] space-y-1">
        <label className="text-xs text-muted-foreground">Phase</label>
        {statusSelect(rung.phase, (id) => onUpdate({ phase: id }), 'Rung phase')}
      </div>
      <div className="min-w-[14rem] flex-1">
        <ConditionEditor
          value={rung.when}
          onChange={(next) => onUpdate({ when: next })}
          fieldOptions={fieldOptions}
          registry={registry}
          disabled={disabled}
        />
      </div>
      <div className="min-w-[12rem] flex-1 space-y-1">
        <label className="text-xs text-muted-foreground">Next action</label>
        <input
          type="text"
          value={rung.next}
          onChange={(e) => onUpdate({ next: e.target.value })}
          disabled={disabled}
          className="w-full rounded-md border border-border/60 bg-background px-2 py-1 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/30 disabled:opacity-60"
        />
      </div>
      <button
        type="button"
        onClick={onRemove}
        disabled={disabled}
        className="mt-5 inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
        aria-label="Remove rung"
      >
        <Trash2 className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
