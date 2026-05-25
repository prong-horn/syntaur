import { useState, useEffect, useCallback } from 'react';
import {
  Plus,
  Trash2,
  ChevronUp,
  ChevronDown,
  RotateCcw,
  Save,
  Info,
  Check,
} from 'lucide-react';
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
import { buildStatusSavePayload, pruneStaleResolutions } from './settings-page-helpers';
import { PRESETS, type ThemeSlug } from '../themes';
import { useTheme } from '../theme';
import { HotkeyBindingsSection } from './HotkeyBindingsSection';
import { ViewDefaultsSection } from './ViewDefaultsSection';
import { AgentsSection } from './AgentsSection';
import { TerminalSection } from './TerminalSection';

interface EditableStatus {
  id: string;
  label: string;
  description: string;
  color: string;
  terminal: boolean;
}

function toEditable(config: StatusConfigResponse): {
  statuses: EditableStatus[];
  order: string[];
} {
  return {
    statuses: config.statuses.map((s) => ({
      id: s.id,
      label: s.label,
      description: s.description ?? '',
      color: s.color ?? '',
      terminal: s.terminal ?? false,
    })),
    order: [...config.order],
  };
}

export function SettingsPage() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [custom, setCustom] = useState(false);
  const [statuses, setStatuses] = useState<EditableStatus[]>([]);
  const [order, setOrder] = useState<string[]>([]);
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
      setStatuses(editable.statuses);
      setOrder(editable.order);
      setCustom(data.custom);
      setSavedStatusIds(new Set(editable.statuses.map((s) => s.id)));
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
      const { body } = buildStatusSavePayload({ statuses, order, pendingResolutions });
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
      setStatuses(editable.statuses);
      setOrder(editable.order);
      setCustom(data.custom);
      setSavedStatusIds(new Set(editable.statuses.map((s) => s.id)));
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
      setStatuses(editable.statuses);
      setOrder(editable.order);
      setCustom(data.custom);
      setSavedStatusIds(new Set(editable.statuses.map((s) => s.id)));
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
  function updateStatus(index: number, field: keyof EditableStatus, value: string | boolean) {
    setStatuses((prev) => {
      const next = [...prev];
      next[index] = { ...next[index], [field]: value };
      if (field === 'id' && typeof value === 'string') {
        const oldId = prev[index].id;
        setOrder((o) => o.map((id) => (id === oldId ? value : id)));
      }
      return next;
    });
    setDirty(true);
  }

  function addStatus() {
    const newId = `status_${statuses.length + 1}`;
    setStatuses((prev) => [...prev, { id: newId, label: 'New Status', description: '', color: '', terminal: false }]);
    setOrder((prev) => [...prev, newId]);
    setDirty(true);
  }

  function dropRowAndPrune(removedId: string) {
    setStatuses((prev) => {
      const nextStatuses = prev.filter((s) => s.id !== removedId);
      const nextIds = new Set(nextStatuses.map((s) => s.id));
      setPendingResolutions((prevRes) => pruneStaleResolutions(prevRes, nextIds));
      return nextStatuses;
    });
    setOrder((prev) => prev.filter((id) => id !== removedId));
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
    setOrder((prev) => prev.filter((id) => id !== pendingId));
    setDirty(true);
    setModalState({ open: false });
  }

  function handleModalCancel() {
    setModalState({ open: false });
  }

  // --- Order mutations ---
  function moveOrder(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= order.length) return;
    setOrder((prev) => {
      const next = [...prev];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
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
        description="Define the statuses assignments can have"
        actions={
          <button className="shell-action text-xs" onClick={addStatus}>
            <Plus className="h-3 w-3" />
            Add Status
          </button>
        }
      >
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border/50 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">
                <th className="pb-2 pr-3">ID</th>
                <th className="pb-2 pr-3">Label</th>
                <th className="pb-2 pr-3">Color</th>
                <th className="pb-2 pr-3">
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span className="cursor-help underline decoration-dotted underline-offset-4">Done State</span>
                        </TooltipTrigger>
                        <TooltipContent className="max-w-xs text-xs font-normal normal-case tracking-normal">
                          When enabled, assignments in this status count as finished — they fill the "done" portion of progress bars and satisfy dependency requirements.
                        </TooltipContent>
                      </Tooltip>
                    </th>
                <th className="pb-2 w-10"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/30">
              {statuses.map((s, i) => (
                <tr key={i}>
                  <td className="py-2 pr-3">
                    {savedStatusIds.has(s.id) ? (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <input
                            type="text"
                            value={s.id}
                            readOnly
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
                        value={s.id}
                        onChange={(e) => updateStatus(i, 'id', e.target.value)}
                        className="editor-input w-full text-sm"
                      />
                    )}
                  </td>
                  <td className="py-2 pr-3">
                    <input
                      type="text"
                      value={s.label}
                      onChange={(e) => updateStatus(i, 'label', e.target.value)}
                      className="editor-input w-full text-sm"
                    />
                  </td>
                  <td className="py-2 pr-3">
                    <ColorPicker
                      value={s.color}
                      onChange={(color) => updateStatus(i, 'color', color)}
                    />
                  </td>
                  <td className="py-2 pr-3">
                    <button
                      type="button"
                      role="switch"
                      aria-checked={s.terminal}
                      onClick={() => updateStatus(i, 'terminal', !s.terminal)}
                      className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background ${
                        s.terminal ? 'bg-primary' : 'bg-muted'
                      }`}
                    >
                      <span
                        className={`pointer-events-none inline-block h-4 w-4 rounded-full bg-background shadow-sm ring-0 transition-transform ${
                          s.terminal ? 'translate-x-4' : 'translate-x-0'
                        }`}
                      />
                    </button>
                  </td>
                  <td className="py-2">
                    <button
                      className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
                      onClick={() => removeStatus(i)}
                      title="Remove status"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </SectionCard>

      {/* Status Order */}
      <SectionCard
        title="Status Order"
        description="Controls display order in the dashboard (Kanban columns, progress bars, dropdowns)"
      >
        <div className="space-y-1">
          {order.map((id, i) => {
            const label = statuses.find((s) => s.id === id)?.label ?? id;
            return (
              <div
                key={i}
                className="flex items-center gap-2 rounded-md border border-border/40 bg-background/60 px-3 py-2 text-sm"
              >
                <span className="mr-1 font-mono text-xs text-muted-foreground/60">{i + 1}</span>
                <span className="flex-1 font-medium">{label}</span>
                <span className="text-xs text-muted-foreground">{id}</span>
                <button
                  className="inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-30"
                  onClick={() => moveOrder(i, -1)}
                  disabled={i === 0}
                  title="Move up"
                >
                  <ChevronUp className="h-3.5 w-3.5" />
                </button>
                <button
                  className="inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-30"
                  onClick={() => moveOrder(i, 1)}
                  disabled={i === order.length - 1}
                  title="Move down"
                >
                  <ChevronDown className="h-3.5 w-3.5" />
                </button>
              </div>
            );
          })}
        </div>
      </SectionCard>

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
