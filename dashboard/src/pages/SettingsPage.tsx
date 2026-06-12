import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  Plus,
  Trash2,
  GripVertical,
  RotateCcw,
  Save,
  Info,
  Check,
} from 'lucide-react';
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
import { LoadingState } from '../components/LoadingState';
import { ErrorState } from '../components/ErrorState';
import { ColorPicker } from '../components/ColorPicker';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../components/ui/tooltip';
import { BackupSection } from '../components/BackupSection';
import type {
  StatusConfigResponse,
  StatusResolution,
  AffectedResponse,
  StatusConfigSaveResponse,
} from '../hooks/useStatusConfig';
import { invalidateStatusConfigCache } from '../hooks/useStatusConfig';
import { StatusDeleteModal } from './StatusDeleteModal';
import { FactDeleteModal } from './FactDeleteModal';
import {
  buildStatusSavePayload,
  pruneStaleResolutions,
  sortStatusesByOrder,
  findStatusRuleReferences,
  headlineReferencesStatus,
  remapStatusInDerive,
  remapStatusInTransitions,
  dropStatusFromDerive,
  dropStatusFromTransitions,
  type StatusRuleReference,
} from './settings-page-helpers';
import { PRESETS, type ThemeSlug } from '../themes';
import { useTheme } from '../theme';
import { HotkeyBindingsSection } from './HotkeyBindingsSection';
import { ViewDefaultsSection } from './ViewDefaultsSection';
import { AgentsSection } from './AgentsSection';
import { TerminalSection } from './TerminalSection';
import { WorkspaceVisibilitySection } from './WorkspaceVisibilitySection';
import { FactsSection } from './FactsSection';
import { DeriveRulesSection } from './DeriveRulesSection';
import { TransitionsSection } from './TransitionsSection';
import {
  toEditableDerive,
  fromEditableDerive,
  validateDeriveSection,
  type EditableDerive,
} from './derive-rules-helpers';
import {
  toEditableTransitions,
  fromEditableTransitions,
  defaultTransitions,
  filterValidTransitions,
  validateTransitions,
  type EditableTransition,
} from './transitions-helpers';
import { acceptedFactsFromRows } from '../components/condition-editor-helpers';
import { validateFactsForSave } from './facts-section-helpers';
import { buildDeriveRegistry } from '@shared/fact-registry';
import { DEFAULT_DERIVE_CONFIG } from '@shared/derive-config';
import type { RawFactDeclaration } from '@shared/fact-registry';

interface EditableStatus {
  rowKey: string;
  id: string;
  label: string;
  description: string;
  color: string;
  terminal: boolean;
}

function makeRowKey(): string {
  return `row_${Math.random().toString(36).slice(2, 10)}_${Date.now().toString(36)}`;
}

// Hydrate the merged Status Definitions list. `statuses` array order IS the
// display order, so we sort the rows by the persisted `config.order` (the
// order consumed by Kanban columns, progress bars, and dropdowns). There is no
// separate `order` state — save derives it back via statuses.map(s => s.id).
function toEditable(config: StatusConfigResponse): EditableStatus[] {
  const rows = config.statuses.map((s) => ({
    rowKey: makeRowKey(),
    id: s.id,
    label: s.label,
    description: s.description ?? '',
    color: s.color ?? '',
    terminal: s.terminal ?? false,
  }));
  return sortStatusesByOrder(rows, config.order);
}

interface SortableStatusRowProps {
  row: EditableStatus;
  isSaved: boolean;
  onUpdate: (field: keyof EditableStatus, value: string | boolean) => void;
  onRemove: () => void;
}

function SortableStatusRow({ row, isSaved, onUpdate, onRemove }: SortableStatusRowProps) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } =
    useSortable({ id: row.rowKey });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    zIndex: isDragging ? 50 : undefined,
    position: isDragging ? ('relative' as const) : undefined,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`surface-panel flex flex-wrap items-center gap-3 px-3 py-2 ${
        isDragging ? 'opacity-60 shadow-lg' : ''
      }`}
    >
      <button
        ref={setActivatorNodeRef}
        {...attributes}
        {...listeners}
        type="button"
        aria-label="Drag to reorder"
        className="cursor-grab active:cursor-grabbing text-muted-foreground/40 hover:text-muted-foreground transition touch-none"
      >
        <GripVertical className="h-4 w-4" />
      </button>

      {/* ID */}
      <div className="min-w-[8rem] flex-1">
        {isSaved ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <input
                type="text"
                value={row.id}
                readOnly
                aria-label="Status ID"
                className="editor-input w-full text-sm cursor-not-allowed opacity-60"
              />
            </TooltipTrigger>
            <TooltipContent className="max-w-xs text-xs font-normal normal-case tracking-normal">
              To rename a saved status, delete the row and create a new one (this triggers the orphan-resolution flow if assignments still reference it).
            </TooltipContent>
          </Tooltip>
        ) : (
          <input
            type="text"
            value={row.id}
            onChange={(e) => onUpdate('id', e.target.value)}
            aria-label="Status ID"
            className="editor-input w-full text-sm"
          />
        )}
      </div>

      {/* Label */}
      <div className="min-w-[8rem] flex-1">
        <input
          type="text"
          value={row.label}
          onChange={(e) => onUpdate('label', e.target.value)}
          aria-label="Status label"
          className="editor-input w-full text-sm"
        />
      </div>

      {/* Description */}
      <div className="min-w-[10rem] flex-1">
        <input
          type="text"
          value={row.description}
          onChange={(e) => onUpdate('description', e.target.value)}
          aria-label="Status description"
          placeholder="description (optional)"
          className="editor-input w-full text-sm"
        />
      </div>

      {/* Color */}
      <ColorPicker
        value={row.color}
        onChange={(color) => onUpdate('color', color)}
        ariaLabel={`Color for ${row.label || row.id}`}
      />

      {/* Done-state toggle */}
      <div className="flex items-center gap-2">
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="cursor-help text-xs text-muted-foreground underline decoration-dotted underline-offset-4">
              Done
            </span>
          </TooltipTrigger>
          <TooltipContent className="max-w-xs text-xs font-normal normal-case tracking-normal">
            When enabled, assignments in this status count as finished — they fill the "done" portion of progress bars and satisfy dependency requirements.
          </TooltipContent>
        </Tooltip>
        <button
          type="button"
          role="switch"
          aria-checked={row.terminal}
          aria-label={`Done state for ${row.label || row.id}`}
          onClick={() => onUpdate('terminal', !row.terminal)}
          className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background ${
            row.terminal ? 'bg-primary' : 'bg-muted'
          }`}
        >
          <span
            className={`pointer-events-none inline-block h-4 w-4 rounded-full bg-background shadow-sm ring-0 transition-transform ${
              row.terminal ? 'translate-x-4' : 'translate-x-0'
            }`}
          />
        </button>
      </div>

      {/* Delete */}
      <button
        type="button"
        className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
        onClick={onRemove}
        title="Remove status"
        aria-label={`Remove status ${row.id}`}
      >
        <Trash2 className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

export function SettingsPage() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [custom, setCustom] = useState(false);
  const [statuses, setStatuses] = useState<EditableStatus[]>([]);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const [dirty, setDirty] = useState(false);

  // Orphan-prompt state. `savedStatusIds` tracks which ids are backed by
  // disk (so we know when the trash-icon click is a delete-of-saved-status
  // that may have orphans). `pendingResolutions` buffers user choices
  // between the trash click and Save. `modalState` controls the modal.
  const [savedStatusIds, setSavedStatusIds] = useState<Set<string>>(new Set());
  const [pendingResolutions, setPendingResolutions] = useState<Map<string, StatusResolution>>(
    new Map(),
  );
  const [modalState, setModalState] = useState<
    | { open: true; affected: AffectedResponse; pendingId: string; ruleReferences: StatusRuleReference[]; headlineReferences: boolean }
    | { open: false }
  >({ open: false });

  // ── Facts (lifted out of FactsSection for the unified save) ──────────────
  const [factRows, setFactRows] = useState<RawFactDeclaration[]>([]);
  const [pendingFactAcks, setPendingFactAcks] = useState<string[]>([]);
  const [factModal, setFactModal] = useState<
    | { open: true; references: Array<{ factName: string; location: string; when: string }> }
    | { open: false }
  >({ open: false });

  // ── Derive rules ─────────────────────────────────────────────────────────
  // `derive` is the editable model (with row keys); `deriveCustom` mirrors the
  // server flag and flips true on any edit. `deriveDirty`/`deriveReset` drive
  // presence semantics in the payload: untouched defaults → omit (preserve);
  // edited → send the object; reset → send null.
  const [derive, setDerive] = useState<EditableDerive>(() => toEditableDerive(DEFAULT_DERIVE_CONFIG));
  const [deriveCustom, setDeriveCustom] = useState(false);
  const [deriveDirty, setDeriveDirty] = useState(false);
  const [deriveReset, setDeriveReset] = useState(false);

  // ── Transitions ──────────────────────────────────────────────────────────
  const [transitions, setTransitions] = useState<EditableTransition[]>([]);
  const [transitionsCustomizing, setTransitionsCustomizing] = useState(false);
  const [knownCommands, setKnownCommands] = useState<string[]>([]);

  // KeyboardSensor needs the sortable coordinate getter so arrow keys move rows
  // within the list (a bare KeyboardSensor only nudges by pixel delta).
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const { preset, setPreset, resetPreset } = useTheme();
  const [themeSaving, setThemeSaving] = useState(false);
  const [themeFeedback, setThemeFeedback] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  async function handleThemeSelect(slug: ThemeSlug) {
    if (slug === preset || themeSaving) return;
    setThemeSaving(true);
    setThemeFeedback(null);
    try {
      await setPreset(slug);
      setThemeFeedback({ type: 'success', message: 'Theme updated' });
      setTimeout(() => setThemeFeedback(null), 2000);
    } catch (err) {
      setThemeFeedback({
        type: 'error',
        message: err instanceof Error ? err.message : 'Failed to save theme',
      });
    } finally {
      setThemeSaving(false);
    }
  }

  async function handleThemeReset() {
    setThemeSaving(true);
    setThemeFeedback(null);
    try {
      await resetPreset();
      setThemeFeedback({ type: 'success', message: 'Theme reset to default' });
      setTimeout(() => setThemeFeedback(null), 2000);
    } catch (err) {
      setThemeFeedback({
        type: 'error',
        message: err instanceof Error ? err.message : 'Failed to reset theme',
      });
    } finally {
      setThemeSaving(false);
    }
  }

  // Hydrate every editable section from a config response. Used on initial
  // load, after a successful save (the POST returns the full GET shape), and
  // after a reset — so all sections stay coherent and `dirty` clears together.
  const hydrateSections = useCallback((data: StatusConfigResponse) => {
    const editable = toEditable(data);
    setStatuses(editable);
    setCustom(data.custom);
    setSavedStatusIds(new Set(editable.map((s) => s.id)));
    setPendingResolutions(new Map());
    setFactRows(data.rawFacts ?? []);
    setPendingFactAcks([]);
    setDerive(toEditableDerive(data.derive ?? DEFAULT_DERIVE_CONFIG));
    setDeriveCustom(data.deriveCustom ?? false);
    setDeriveDirty(false);
    setDeriveReset(false);
    setTransitions(toEditableTransitions(data.transitions ?? []));
    setTransitionsCustomizing(data.transitionsCustom ?? false);
    setKnownCommands(data.knownCommands ?? []);
    setDirty(false);
  }, []);

  const loadConfig = useCallback(async () => {
    try {
      const res = await fetch('/api/config/statuses');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: StatusConfigResponse = await res.json();
      hydrateSections(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load config');
    } finally {
      setLoading(false);
    }
  }, [hydrateSections]);

  useEffect(() => { loadConfig(); }, [loadConfig]);

  function clearFeedback() {
    setTimeout(() => setFeedback(null), 3000);
  }

  // ── Derived: shared section inputs + cross-section validation ─────────────
  const statusOptions = useMemo(() => statuses.map((s) => ({ id: s.id, label: s.label })), [statuses]);
  const statusIds = useMemo(() => new Set(statuses.map((s) => s.id)), [statuses]);
  const acceptedFacts = useMemo(() => acceptedFactsFromRows(factRows), [factRows]);
  const deriveRegistry = useMemo(() => buildDeriveRegistry(acceptedFacts), [acceptedFacts]);

  const factProblems = useMemo(() => validateFactsForSave(factRows), [factRows]);
  const deriveProblems = useMemo(() => {
    try {
      return validateDeriveSection(fromEditableDerive(derive), statuses, deriveRegistry);
    } catch {
      return ['derive rules are malformed'];
    }
  }, [derive, statuses, deriveRegistry]);
  const transitionProblems = useMemo(
    () => (transitionsCustomizing ? validateTransitions(transitions, statusIds) : []),
    [transitions, transitionsCustomizing, statusIds],
  );
  const sectionProblems = factProblems.length + deriveProblems.length + transitionProblems.length;

  // ── Section change handlers (each marks the unified dirty flag) ───────────
  const onFactsChange = useCallback((rows: RawFactDeclaration[]) => {
    setFactRows(rows);
    setDirty(true);
  }, []);
  const onDeriveChange = useCallback((next: EditableDerive) => {
    setDerive(next);
    setDeriveDirty(true);
    setDeriveReset(false);
    setDeriveCustom(true);
    setDirty(true);
  }, []);
  const onDeriveReset = useCallback(() => {
    setDerive(toEditableDerive(DEFAULT_DERIVE_CONFIG));
    setDeriveReset(true);
    setDeriveDirty(true);
    setDeriveCustom(false);
    setDirty(true);
  }, []);
  const onTransitionsChange = useCallback((next: EditableTransition[]) => {
    setTransitions(next);
    setDirty(true);
  }, []);
  const onTransitionsCustomize = useCallback(() => {
    setTransitions((prev) =>
      prev.length > 0 ? prev : toEditableTransitions(filterValidTransitions(defaultTransitions(), statusIds)),
    );
    setTransitionsCustomizing(true);
    setDirty(true);
  }, [statusIds]);

  async function handleSave(acks: string[] = pendingFactAcks) {
    setSaving(true);
    setFeedback(null);
    try {
      const { body } = buildStatusSavePayload({
        statuses,
        order: statuses.map((s) => s.id),
        pendingResolutions,
        facts: factRows,
        factRemovalAcks: acks,
        derive: deriveReset ? null : deriveDirty ? fromEditableDerive(derive) : undefined,
        transitions: transitionsCustomizing ? fromEditableTransitions(transitions) : undefined,
      });
      const res = await fetch('/api/config/statuses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const errBody = await res.json().catch(() => null);
        if (res.status === 409 && errBody?.error === 'unresolved-fact-references' && errBody.references) {
          setFactModal({ open: true, references: errBody.references });
          setSaving(false);
          return;
        }
        if (errBody?.error === 'invalid-derive') {
          throw new Error(`Invalid derive rules: ${(errBody.problems ?? []).join('; ')}`);
        }
        if (errBody?.error === 'invalid-transitions') {
          throw new Error(`Invalid transitions: ${(errBody.problems ?? []).join('; ')}`);
        }
        if (errBody?.error === 'invalid-facts') {
          throw new Error(`Invalid facts: ${(errBody.problems ?? []).join('; ')}`);
        }
        if (res.status === 409 && errBody?.error === 'unresolved-orphans') {
          const ids = Array.isArray(errBody.unresolved)
            ? errBody.unresolved.map((u: { id: string }) => u.id).join(', ')
            : '';
          throw new Error(
            `Cannot save — these statuses have assignments that need a resolution: ${ids}. Click the trash icon on each row to choose remap or delete.`,
          );
        }
        if (res.status === 409 && errBody?.error === 'concurrent-edit') {
          const applied = errBody.applied
            ? ` (${errBody.applied.remapped} remapped, ${errBody.applied.deleted} deleted before the conflict)`
            : '';
          setFeedback({
            type: 'error',
            message: `Concurrent edit detected${applied}: ${errBody.cause ?? 'an assignment moved to a still-dropped status during save'}. Refreshing — please re-resolve.`,
          });
          await loadConfig();
          return;
        }
        if (res.status === 500 && errBody?.error === 'config-write-failed' && errBody?.applied) {
          const { remapped, deleted } = errBody.applied;
          const cause = errBody.message ? `: ${errBody.message}` : '';
          setFeedback({
            type: 'error',
            message: `Resolutions applied (${remapped} remapped, ${deleted} deleted) but the status config write failed${cause}. Click Save again to retry.`,
          });
          await loadConfig();
          return;
        }
        if (errBody?.error === 'invalid-remap-target') {
          throw new Error(
            `Invalid remap target (${errBody.reason}): ${errBody.id} → ${errBody.target}.`,
          );
        }
        if (errBody?.error === 'duplicate-resolution-ids') {
          throw new Error(`Duplicate resolution ids: ${(errBody.ids ?? []).join(', ')}`);
        }
        if (errBody?.error === 'stale-resolution') {
          throw new Error(`Stale resolution for id "${errBody.id ?? '?'}".`);
        }
        if (errBody?.error === 'malformed-resolutions') {
          throw new Error(`Malformed resolutions: ${errBody.message ?? 'unknown'}`);
        }
        if (errBody?.error === 'remap-write-failed' || errBody?.error === 'delete-failed' || errBody?.error === 'scan-failed') {
          throw new Error(`${errBody.error}: ${errBody.cause ?? 'unknown'}`);
        }
        throw new Error(errBody?.error ?? `Save failed (HTTP ${res.status})`);
      }
      const data: StatusConfigSaveResponse = await res.json();
      hydrateSections(data);
      invalidateStatusConfigCache();
      const appliedMsg = data.applied
        ? ` (${data.applied.remapped} remapped, ${data.applied.deleted} deleted)`
        : '';
      setFeedback({ type: 'success', message: `Status config saved${appliedMsg}` });
      clearFeedback();
    } catch (err) {
      setFeedback({ type: 'error', message: err instanceof Error ? err.message : 'Save failed' });
    } finally {
      setSaving(false);
    }
  }

  async function handleReset() {
    setSaving(true);
    setFeedback(null);
    try {
      const res = await fetch('/api/config/statuses', { method: 'DELETE' });
      if (!res.ok) throw new Error('Reset failed');
      const data: StatusConfigResponse = await res.json();
      hydrateSections(data);
      invalidateStatusConfigCache();
      setFeedback({ type: 'success', message: 'Reset to defaults' });
      clearFeedback();
    } catch (err) {
      setFeedback({ type: 'error', message: err instanceof Error ? err.message : 'Reset failed' });
    } finally {
      setSaving(false);
    }
  }

  // --- Status definition mutations ---
  // Handlers are index-based: the rendered list maps directly over `statuses`,
  // so the row's array index is its position. `statuses` array order is also
  // the persisted display order (derived as statuses.map(s => s.id) on save).
  function updateStatus(index: number, field: keyof EditableStatus, value: string | boolean) {
    setStatuses((prev) => {
      const next = [...prev];
      next[index] = { ...next[index], [field]: value };
      return next;
    });
    setDirty(true);
  }

  function addStatus() {
    const newId = `status_${statuses.length + 1}`;
    setStatuses((prev) => [
      ...prev,
      { rowKey: makeRowKey(), id: newId, label: 'New Status', description: '', color: '', terminal: false },
    ]);
    setDirty(true);
  }

  function dropRowAndPrune(removedId: string) {
    setStatuses((prev) => {
      const nextStatuses = prev.filter((s) => s.id !== removedId);
      const nextIds = new Set(nextStatuses.map((s) => s.id));
      setPendingResolutions((prevRes) => pruneStaleResolutions(prevRes, nextIds));
      return nextStatuses;
    });
    setDirty(true);
  }

  async function removeStatus(index: number) {
    const removedId = statuses[index].id;
    const ruleReferences = findStatusRuleReferences(removedId, derive, transitions);
    const headlineReferences = headlineReferencesStatus(removedId, derive);

    // Row added in this session (not on disk yet) — no assignments possible.
    if (!savedStatusIds.has(removedId)) {
      if (ruleReferences.length === 0) {
        dropRowAndPrune(removedId);
        return;
      }
      setModalState({
        open: true,
        affected: { id: removedId, count: 0, truncated: false, assignments: [] },
        pendingId: removedId,
        ruleReferences,
        headlineReferences,
      });
      return;
    }

    // Row backed by disk — check for affected assignments.
    try {
      const res = await fetch(`/api/config/statuses/affected/${encodeURIComponent(removedId)}`);
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const affected: AffectedResponse = await res.json();
      if (affected.count === 0 && ruleReferences.length === 0) {
        dropRowAndPrune(removedId);
        return;
      }
      setModalState({ open: true, affected, pendingId: removedId, ruleReferences, headlineReferences });
    } catch (err) {
      setFeedback({
        type: 'error',
        message: `Could not check affected assignments for "${removedId}": ${
          err instanceof Error ? err.message : String(err)
        }`,
      });
    }
  }

  function handleModalResolve(resolution: StatusResolution, deriveRemapTarget: string) {
    if (!modalState.open) return;
    const { pendingId, affected, ruleReferences } = modalState;
    if (pendingId !== resolution.id) {
      setModalState({ open: false });
      return;
    }
    // Verify the row still exists in the current statuses array (it should,
    // unless the user did something weird like a rapid-fire double-click).
    if (!statuses.some((s) => s.id === pendingId)) {
      setFeedback({
        type: 'error',
        message: `Row for "${pendingId}" was already removed — modal action ignored.`,
      });
      setModalState({ open: false });
      return;
    }

    // Rewrite derive/transition references locally before the payload is built.
    if (resolution.mode === 'remap') {
      setDerive((d) => remapStatusInDerive(d, pendingId, deriveRemapTarget));
      setTransitions((t) => remapStatusInTransitions(t, pendingId, deriveRemapTarget));
    } else {
      // delete: drop ladder rungs + transitions; headline (if referenced)
      // remaps to the chosen target (headline cannot reference nothing).
      setDerive((d) => dropStatusFromDerive(d, pendingId, deriveRemapTarget));
      setTransitions((t) => dropStatusFromTransitions(t, pendingId));
    }
    if (ruleReferences.some((r) => r.section !== 'transitions')) {
      setDeriveDirty(true);
      setDeriveCustom(true);
    }

    setStatuses((prev) => {
      const nextStatuses = prev.filter((s) => s.id !== pendingId);
      const nextIds = new Set(nextStatuses.map((s) => s.id));
      setPendingResolutions((prevRes) => {
        // First drop resolutions whose target is now gone (because we just
        // removed pendingId), then add the new resolution for pendingId — but
        // only when there are real assignments to resolve (count 0 needs none).
        const pruned = pruneStaleResolutions(prevRes, nextIds);
        const next = new Map(pruned);
        if (affected.count > 0) next.set(pendingId, resolution);
        return next;
      });
      return nextStatuses;
    });
    setDirty(true);
    setModalState({ open: false });
  }

  function handleFactModalConfirm() {
    if (!factModal.open) return;
    const refs = factModal.references.map((r) => r.factName);
    const acks = Array.from(new Set([...pendingFactAcks, ...refs]));
    setPendingFactAcks(acks);
    setFactModal({ open: false });
    void handleSave(acks);
  }

  function handleModalCancel() {
    setModalState({ open: false });
  }

  // --- Drag-to-reorder ---
  // Reordering the row list reorders the persisted display order (derived at
  // save). It does not touch pendingResolutions/savedStatusIds, which are keyed
  // by status id, so the orphan-resolution flow is unaffected.
  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    setStatuses((prev) => {
      const oldIndex = prev.findIndex((s) => s.rowKey === active.id);
      const newIndex = prev.findIndex((s) => s.rowKey === over.id);
      if (oldIndex === -1 || newIndex === -1) return prev;
      return arrayMove(prev, oldIndex, newIndex);
    });
    setDirty(true);
  }

  if (loading) return <LoadingState label="Loading settings..." />;
  if (error) return <ErrorState error={error} />;

  return (
    <TooltipProvider>
    <div className="space-y-6">
      {/* Theme */}
      <SectionCard
        title="Theme"
        description="Pick a color theme for the dashboard. The default is the Syntaur brand."
        actions={
          preset !== 'default' ? (
            <button
              className="shell-action text-xs"
              onClick={handleThemeReset}
              disabled={themeSaving}
            >
              <RotateCcw className="h-3 w-3" />
              Reset
            </button>
          ) : undefined
        }
      >
        {themeFeedback && (
          <div className={`mb-3 rounded-md border px-3 py-1.5 text-xs ${
            themeFeedback.type === 'success'
              ? 'border-success-foreground/30 bg-success text-success-foreground'
              : 'border-error-foreground/30 bg-error text-error-foreground'
          }`}>
            {themeFeedback.message}
          </div>
        )}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {PRESETS.map((p) => {
            const selected = p.slug === preset;
            return (
              <button
                key={p.slug}
                type="button"
                onClick={() => handleThemeSelect(p.slug)}
                disabled={themeSaving}
                aria-pressed={selected}
                className={`group relative flex flex-col gap-2 rounded-lg border bg-card/95 p-3 text-left transition disabled:opacity-60 ${
                  selected
                    ? 'border-primary ring-2 ring-primary/40'
                    : 'border-border/60 hover:border-primary/40'
                }`}
              >
                <div className="flex items-center gap-1.5">
                  <span
                    className="h-5 w-5 rounded-full ring-1 ring-border/60"
                    style={{ background: p.swatches.primary }}
                  />
                  <span
                    className="h-5 w-5 rounded-full ring-1 ring-border/60"
                    style={{ background: p.swatches.secondary }}
                  />
                  <span
                    className="h-5 w-5 rounded-full ring-1 ring-border/60"
                    style={{ background: p.swatches.coral }}
                  />
                  <span
                    className="h-5 w-5 rounded-full ring-1 ring-border/60"
                    style={{ background: p.swatches.teal }}
                  />
                  <span
                    className="h-5 w-5 rounded-full ring-1 ring-border/60"
                    style={{ background: p.swatches.amber }}
                  />
                  {selected && (
                    <span className="ml-auto inline-flex h-5 w-5 items-center justify-center rounded-full bg-primary text-primary-foreground">
                      <Check className="h-3 w-3" />
                    </span>
                  )}
                </div>
                <div>
                  <div className="text-sm font-medium text-foreground">{p.label}</div>
                  <div className="text-xs text-muted-foreground">{p.description}</div>
                </div>
              </button>
            );
          })}
        </div>
      </SectionCard>

      <HotkeyBindingsSection />

      <TerminalSection />

      <WorkspaceVisibilitySection />

      <AgentsSection />

      <ViewDefaultsSection />

      {/* Config state banner */}
      <div className={`flex items-center justify-between rounded-lg border px-4 py-3 text-sm ${
        custom
          ? 'border-primary/30 bg-primary/5 text-primary'
          : 'border-border/60 bg-muted/30 text-muted-foreground'
      }`}>
        <div className="flex items-center gap-2">
          <Info className="h-4 w-4" />
          {custom
            ? 'Using custom status configuration from ~/.syntaur/config.md'
            : 'Using default status configuration'}
        </div>
        <button
          className="shell-action text-xs"
          onClick={handleReset}
          disabled={saving || (!custom && !dirty)}
        >
          <RotateCcw className="h-3 w-3" />
          Reset to Defaults
        </button>
      </div>

      {/* Feedback banner */}
      {feedback && (
        <div className={`rounded-lg border px-4 py-2 text-sm ${
          feedback.type === 'success'
            ? 'border-success-foreground/30 bg-success text-success-foreground'
            : 'border-error-foreground/30 bg-error text-error-foreground'
        }`}>
          {feedback.message}
        </div>
      )}

      {/* Status Definitions */}
      <SectionCard
        title="Status Definitions"
        description="Define the statuses assignments can have. Drag rows to set the display order used by Kanban columns, progress bars, and dropdowns."
        actions={
          <button className="shell-action text-xs" onClick={addStatus}>
            <Plus className="h-3 w-3" />
            Add Status
          </button>
        }
      >
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext items={statuses.map((s) => s.rowKey)} strategy={verticalListSortingStrategy}>
            <div className="space-y-2">
              {statuses.map((s, i) => (
                <SortableStatusRow
                  key={s.rowKey}
                  row={s}
                  isSaved={savedStatusIds.has(s.id)}
                  onUpdate={(field, value) => updateStatus(i, field, value)}
                  onRemove={() => removeStatus(i)}
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>
      </SectionCard>

      <DeriveRulesSection
        value={derive}
        deriveCustom={deriveCustom}
        statuses={statusOptions}
        acceptedFacts={acceptedFacts}
        onChange={onDeriveChange}
        onReset={onDeriveReset}
        disabled={saving}
      />

      <TransitionsSection
        value={transitions}
        customizing={transitionsCustomizing}
        statuses={statusOptions}
        knownCommands={knownCommands}
        onChange={onTransitionsChange}
        onCustomize={onTransitionsCustomize}
        disabled={saving}
      />

      <FactsSection rows={factRows} onChange={onFactsChange} saving={saving} />

      {/* Save bar */}
      <div className="flex items-center gap-3">
        <button
          className="shell-action bg-primary/10 text-primary hover:bg-primary/20 disabled:opacity-50"
          onClick={() => void handleSave()}
          disabled={saving || !dirty || sectionProblems > 0}
        >
          <Save className="h-3.5 w-3.5" />
          {saving ? 'Saving...' : 'Save Configuration'}
        </button>
        {dirty && (
          <>
            <button
              className="shell-action text-xs"
              onClick={() => { setLoading(true); loadConfig(); }}
              disabled={saving}
            >
              Discard Changes
            </button>
            <span className="text-xs text-muted-foreground">
              {sectionProblems > 0 ? 'Fix the highlighted errors to save' : 'Unsaved changes'}
            </span>
          </>
        )}
      </div>

      {/* GitHub Backup */}
      <BackupSection />

      {/* Orphan-prompt modal */}
      {modalState.open && (
        <StatusDeleteModal
          open={modalState.open}
          affected={{
            ...modalState.affected,
            label:
              statuses.find((s) => s.id === modalState.affected.id)?.label ??
              modalState.affected.id,
          }}
          remaining={statuses
            .filter((s) => s.id !== modalState.affected.id && savedStatusIds.has(s.id))
            .map((s) => ({ id: s.id, label: s.label }))}
          ruleReferences={modalState.ruleReferences}
          headlineReferences={modalState.headlineReferences}
          onResolve={handleModalResolve}
          onCancel={handleModalCancel}
        />
      )}

      {/* Fact-reference modal (unified save 409 ack) */}
      <FactDeleteModal
        open={factModal.open}
        references={factModal.open ? factModal.references : []}
        onConfirm={handleFactModalConfirm}
        onCancel={() => {
          setFactModal({ open: false });
          setSaving(false);
        }}
      />
    </div>
    </TooltipProvider>
  );
}
