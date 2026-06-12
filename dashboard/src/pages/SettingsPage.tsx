import { useState, useEffect, useCallback } from 'react';
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
import { buildStatusSavePayload, pruneStaleResolutions, sortStatusesByOrder } from './settings-page-helpers';
import { PRESETS, type ThemeSlug } from '../themes';
import { useTheme } from '../theme';
import { HotkeyBindingsSection } from './HotkeyBindingsSection';
import { ViewDefaultsSection } from './ViewDefaultsSection';
import { AgentsSection } from './AgentsSection';
import { TerminalSection } from './TerminalSection';
import { WorkspaceVisibilitySection } from './WorkspaceVisibilitySection';
import { FactsSection } from './FactsSection';

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
    | { open: true; affected: AffectedResponse; pendingId: string }
    | { open: false }
  >({ open: false });

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

  const loadConfig = useCallback(async () => {
    try {
      const res = await fetch('/api/config/statuses');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: StatusConfigResponse = await res.json();
      const editable = toEditable(data);
      setStatuses(editable);
      setCustom(data.custom);
      setSavedStatusIds(new Set(editable.map((s) => s.id)));
      setPendingResolutions(new Map());
      setDirty(false);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load config');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadConfig(); }, [loadConfig]);

  function clearFeedback() {
    setTimeout(() => setFeedback(null), 3000);
  }

  async function handleSave() {
    setSaving(true);
    setFeedback(null);
    try {
      const { body } = buildStatusSavePayload({
        statuses,
        order: statuses.map((s) => s.id),
        pendingResolutions,
      });
      const res = await fetch('/api/config/statuses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const errBody = await res.json().catch(() => null);
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
      const editable = toEditable(data);
      setStatuses(editable);
      setCustom(data.custom);
      setSavedStatusIds(new Set(editable.map((s) => s.id)));
      setPendingResolutions(new Map());
      setDirty(false);
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
      const editable = toEditable(data);
      setStatuses(editable);
      setCustom(data.custom);
      setSavedStatusIds(new Set(editable.map((s) => s.id)));
      setPendingResolutions(new Map());
      setDirty(false);
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

    // Row added in this session (not on disk yet) — drop locally, no prompt.
    if (!savedStatusIds.has(removedId)) {
      dropRowAndPrune(removedId);
      return;
    }

    // Row backed by disk — check for affected assignments.
    try {
      const res = await fetch(`/api/config/statuses/affected/${encodeURIComponent(removedId)}`);
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const affected: AffectedResponse = await res.json();
      if (affected.count === 0) {
        dropRowAndPrune(removedId);
        return;
      }
      setModalState({ open: true, affected, pendingId: removedId });
    } catch (err) {
      setFeedback({
        type: 'error',
        message: `Could not check affected assignments for "${removedId}": ${
          err instanceof Error ? err.message : String(err)
        }`,
      });
    }
  }

  function handleModalResolve(resolution: StatusResolution) {
    if (!modalState.open) return;
    const { pendingId } = modalState;
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
    setStatuses((prev) => {
      const nextStatuses = prev.filter((s) => s.id !== pendingId);
      const nextIds = new Set(nextStatuses.map((s) => s.id));
      setPendingResolutions((prevRes) => {
        // First drop resolutions whose target is now gone (because we just
        // removed pendingId), then add the new resolution for pendingId.
        const pruned = pruneStaleResolutions(prevRes, nextIds);
        const next = new Map(pruned);
        next.set(pendingId, resolution);
        return next;
      });
      return nextStatuses;
    });
    setDirty(true);
    setModalState({ open: false });
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

      <FactsSection />

      {/* Save bar */}
      <div className="flex items-center gap-3">
        <button
          className="shell-action bg-primary/10 text-primary hover:bg-primary/20"
          onClick={handleSave}
          disabled={saving || !dirty}
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
            <span className="text-xs text-muted-foreground">Unsaved changes</span>
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
          onResolve={handleModalResolve}
          onCancel={handleModalCancel}
        />
      )}
    </div>
    </TooltipProvider>
  );
}
