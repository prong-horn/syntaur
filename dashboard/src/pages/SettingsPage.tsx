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
import type { StatusConfigResponse } from '../hooks/useStatusConfig';
import { invalidateStatusConfigCache } from '../hooks/useStatusConfig';
import { PRESETS, type ThemeSlug } from '../themes';
import { useTheme } from '../theme';

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
      const body = {
        statuses: statuses.map((s) => ({
          id: s.id,
          label: s.label,
          ...(s.description ? { description: s.description } : {}),
          ...(s.color ? { color: s.color } : {}),
          ...(s.terminal ? { terminal: true } : {}),
        })),
        order,
        transitions: [],
      };
      const res = await fetch('/api/config/statuses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Unknown error' }));
        throw new Error(err.error ?? 'Save failed');
      }
      const data: StatusConfigResponse = await res.json();
      const editable = toEditable(data);
      setStatuses(editable.statuses);
      setOrder(editable.order);
      setCustom(data.custom);
      setDirty(false);
      invalidateStatusConfigCache();
      setFeedback({ type: 'success', message: 'Status config saved' });
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

  function removeStatus(index: number) {
    const removedId = statuses[index].id;
    setStatuses((prev) => prev.filter((_, i) => i !== index));
    setOrder((prev) => prev.filter((id) => id !== removedId));
    setDirty(true);
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
              ? 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-400'
              : 'border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-400'
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
            ? 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-400'
            : 'border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-400'
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
                    <input
                      type="text"
                      value={s.id}
                      onChange={(e) => updateStatus(i, 'id', e.target.value)}
                      className="editor-input w-full text-sm"
                    />
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
    </div>
    </TooltipProvider>
  );
}
