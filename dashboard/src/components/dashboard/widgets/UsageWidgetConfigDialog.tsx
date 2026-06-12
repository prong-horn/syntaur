import { useEffect, useState } from 'react';
import type { WidgetConfig } from '@shared/saved-views-schema';
import {
  USAGE_WINDOWS,
  normalizeFilters,
  validateFilters,
  type UsageWidgetFilters,
  type UsageWindow,
} from '@shared/usage-filters';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../ui/dialog';
import { useProjects, useWorkspaces, useUsageFacets } from '../../../hooks/useProjects';

interface UsageWidgetConfigDialogProps {
  config: WidgetConfig;
  open: boolean;
  onSave: (next: WidgetConfig) => Promise<void>;
  onCancel: () => void;
}

const WINDOW_LABEL: Record<UsageWindow, string> = {
  '7d': '7 days',
  '30d': '30 days',
  '90d': '90 days',
  all: 'All time',
  custom: 'Custom',
};

function initialFilters(config: WidgetConfig): UsageWidgetFilters {
  return config.kind === 'token-usage' || config.kind === 'spend' ? config.filters ?? {} : {};
}

const selectClass =
  'bg-background border border-border rounded px-2 py-1 text-sm text-foreground';

/**
 * Per-widget filter editor for the Token Usage / Spend widgets. Mounted by
 * `WidgetSlot` via the registry's optional `ConfigEditor` capability, so the
 * slot stays generic. Save is async: it normalizes + validates, calls `onSave`
 * (which persists the layout), and on failure keeps the dialog open with the
 * error shown and the button re-enabled.
 */
export function UsageWidgetConfigDialog({ config, open, onSave, onCancel }: UsageWidgetConfigDialogProps) {
  const title = config.kind === 'spend' ? 'Configure Spend' : 'Configure Token Usage';
  const { data: projects } = useProjects();
  const { data: workspacesData } = useWorkspaces();
  const { data: facets } = useUsageFacets(open);

  const [window, setWindow] = useState<UsageWindow>('30d');
  const [since, setSince] = useState('');
  const [until, setUntil] = useState('');
  const [project, setProject] = useState('');
  const [workspace, setWorkspace] = useState('');
  const [model, setModel] = useState('');
  const [tool, setTool] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Seed form state from the current config each time the dialog opens.
  useEffect(() => {
    if (!open) return;
    const f = initialFilters(config);
    setWindow(f.window ?? '30d');
    setSince(f.since ?? '');
    setUntil(f.until ?? '');
    setProject(f.project ?? '');
    setWorkspace(f.workspace ?? '');
    setModel(f.model ?? '');
    setTool(f.tool ?? '');
    setSubmitting(false);
    setError(null);
  }, [open, config]);

  function buildFilters(): UsageWidgetFilters {
    return normalizeFilters({
      window,
      since: window === 'custom' ? since : undefined,
      until: window === 'custom' ? until : undefined,
      // `workspace` and `project` are mutually exclusive server-side; the
      // selects below enforce that by clearing the other when one is chosen.
      project: project || undefined,
      workspace: workspace || undefined,
      model: model || undefined,
      tool: tool || undefined,
    });
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (submitting) return;
    const next = buildFilters();
    const result = validateFilters(next);
    if (!result.ok) {
      setError(result.errors.join('; '));
      return;
    }
    setSubmitting(true);
    setError(null);
    // ConfigEditor is only mounted for usage kinds, but narrow explicitly so the
    // discriminated union stays sound (saved-view/inventories carry no filters).
    const nextConfig: WidgetConfig =
      config.kind === 'token-usage'
        ? { kind: 'token-usage', filters: next }
        : config.kind === 'spend'
          ? { kind: 'spend', filters: next }
          : config;
    try {
      await onSave(nextConfig);
      // Parent closes the dialog (open=false) on success.
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSubmitting(false);
    }
  }

  const projectOptions = projects?.map((p) => p.slug) ?? [];
  const workspaceOptions = workspacesData?.workspaces ?? [];
  const showUngrouped = workspacesData?.hasUngrouped ?? false;

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onCancel(); }}>
      <DialogContent className="max-w-md">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
          </DialogHeader>

          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Window</span>
              <div className="flex flex-wrap gap-1.5">
                {USAGE_WINDOWS.map((w) => (
                  <button
                    key={w}
                    type="button"
                    onClick={() => setWindow(w)}
                    className={
                      'rounded px-2.5 py-1 text-sm border ' +
                      (w === window
                        ? 'border-primary bg-primary/10 text-foreground'
                        : 'border-border text-muted-foreground hover:text-foreground')
                    }
                  >
                    {WINDOW_LABEL[w]}
                  </button>
                ))}
              </div>
            </div>

            {window === 'custom' ? (
              <div className="flex gap-3">
                <label className="flex flex-1 flex-col gap-1 text-sm">
                  <span className="text-muted-foreground">Since</span>
                  <input type="date" value={since} onChange={(e) => setSince(e.target.value)} className={selectClass} />
                </label>
                <label className="flex flex-1 flex-col gap-1 text-sm">
                  <span className="text-muted-foreground">Until</span>
                  <input type="date" value={until} onChange={(e) => setUntil(e.target.value)} className={selectClass} />
                </label>
              </div>
            ) : null}

            <label className="flex flex-col gap-1 text-sm">
              <span className="text-muted-foreground">Workspace</span>
              <select
                value={workspace}
                onChange={(e) => {
                  setWorkspace(e.target.value);
                  if (e.target.value) setProject(''); // mutually exclusive with project
                }}
                className={selectClass}
              >
                <option value="">All workspaces</option>
                {showUngrouped ? <option value="_ungrouped">(ungrouped)</option> : null}
                {workspaceOptions.map((w) => (
                  <option key={w} value={w}>{w}</option>
                ))}
              </select>
            </label>

            <label className="flex flex-col gap-1 text-sm">
              <span className="text-muted-foreground">Project</span>
              <select
                value={project}
                onChange={(e) => {
                  setProject(e.target.value);
                  if (e.target.value) setWorkspace(''); // mutually exclusive with workspace
                }}
                className={selectClass}
              >
                <option value="">All projects</option>
                {projectOptions.map((p) => (
                  <option key={p} value={p}>{p}</option>
                ))}
              </select>
            </label>

            <div className="flex gap-3">
              <label className="flex flex-1 flex-col gap-1 text-sm">
                <span className="text-muted-foreground">Model</span>
                <select value={model} onChange={(e) => setModel(e.target.value)} className={selectClass}>
                  <option value="">All models</option>
                  {(facets?.models ?? []).map((m) => (
                    <option key={m} value={m}>{m}</option>
                  ))}
                </select>
              </label>
              <label className="flex flex-1 flex-col gap-1 text-sm">
                <span className="text-muted-foreground">Tool</span>
                <select value={tool} onChange={(e) => setTool(e.target.value)} className={selectClass}>
                  <option value="">All tools</option>
                  {(facets?.tools ?? []).map((t) => (
                    <option key={t} value={t}>{t}</option>
                  ))}
                </select>
              </label>
            </div>

            {error ? (
              <p className="text-xs text-destructive" role="alert">{error}</p>
            ) : null}
          </div>

          <DialogFooter className="sm:justify-between">
            <button type="button" onClick={onCancel} disabled={submitting} className="shell-action">
              Cancel
            </button>
            <button type="submit" disabled={submitting} className="shell-action shell-action--cta">
              {submitting ? 'Saving…' : 'Save'}
            </button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
