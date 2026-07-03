import { useState } from 'react';
import { Plus, Trash2, Save } from 'lucide-react';
import { SectionCard } from './SectionCard';
import { useWorkflows } from '../hooks/useStatusConfig';

interface TypeRow {
  type: string;
  workflow: string;
}

/** Project → workflow binding editor (Task 13): a default-workflow dropdown plus
 * a `type → workflow` table. Persists via PUT /api/projects/:slug/workflow-binding. */
export function ProjectWorkflowSection({
  projectSlug,
  defaultWorkflow,
  workflowByType,
  onSaved,
}: {
  projectSlug: string;
  defaultWorkflow: string | null | undefined;
  workflowByType: Record<string, string> | undefined;
  onSaved: () => void;
}) {
  const { workflows } = useWorkflows();
  const [defaultWf, setDefaultWf] = useState(defaultWorkflow ?? '');
  const [rows, setRows] = useState<TypeRow[]>(
    Object.entries(workflowByType ?? {}).map(([type, workflow]) => ({ type, workflow })),
  );
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; message: string } | null>(
    null,
  );

  const wfOptions = workflows.map((w) => ({ id: w.id, label: w.label }));

  function updateRow(index: number, patch: Partial<TypeRow>) {
    setRows((prev) => prev.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  }

  async function save() {
    setSaving(true);
    setFeedback(null);
    // Drop incomplete rows; last write wins on duplicate type keys.
    const workflowByTypePayload: Record<string, string> = {};
    for (const r of rows) {
      const type = r.type.trim();
      if (type && r.workflow) workflowByTypePayload[type] = r.workflow;
    }
    try {
      const res = await fetch(
        `/api/projects/${encodeURIComponent(projectSlug)}/workflow-binding`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            defaultWorkflow: defaultWf || null,
            workflowByType: workflowByTypePayload,
          }),
        },
      );
      if (!res.ok) {
        const e = await res.json().catch(() => null);
        throw new Error(e?.error ?? `HTTP ${res.status}`);
      }
      setFeedback({ type: 'success', message: 'Workflow binding saved' });
      onSaved();
    } catch (e) {
      setFeedback({ type: 'error', message: e instanceof Error ? e.message : 'Save failed' });
    } finally {
      setSaving(false);
    }
  }

  return (
    <SectionCard
      title="Workflow binding"
      description="Which lifecycle workflow this project's tickets follow. A per-type mapping wins over the project default; both are overridable per ticket."
    >
      <div className="space-y-4">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-xs font-medium text-muted-foreground">Default workflow</span>
          <select
            className="w-full max-w-xs rounded-md border border-border/60 bg-background px-2 py-1 text-sm"
            value={defaultWf}
            onChange={(e) => setDefaultWf(e.target.value)}
          >
            <option value="">Inherit global default</option>
            {wfOptions.map((w) => (
              <option key={w.id} value={w.id}>
                {w.label}
              </option>
            ))}
          </select>
        </label>

        <div className="space-y-2">
          <span className="text-xs font-medium text-muted-foreground">Type → workflow</span>
          {rows.length === 0 && (
            <p className="text-xs text-muted-foreground">
              No per-type mappings — every ticket uses the default above.
            </p>
          )}
          {rows.map((row, index) => (
            <div key={index} className="flex items-center gap-2">
              <input
                className="w-40 rounded-md border border-border/60 bg-background px-2 py-1 text-xs"
                placeholder="type (e.g. bug)"
                value={row.type}
                onChange={(e) => updateRow(index, { type: e.target.value })}
              />
              <span className="text-muted-foreground">→</span>
              <select
                className="w-40 rounded-md border border-border/60 bg-background px-2 py-1 text-xs"
                value={row.workflow}
                onChange={(e) => updateRow(index, { workflow: e.target.value })}
              >
                <option value="">Select workflow…</option>
                {wfOptions.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.label}
                  </option>
                ))}
              </select>
              <button
                className="shell-action text-xs text-error-foreground"
                onClick={() => setRows((prev) => prev.filter((_, i) => i !== index))}
                aria-label="Remove mapping"
              >
                <Trash2 className="h-3 w-3" />
              </button>
            </div>
          ))}
          <button
            className="shell-action text-xs"
            onClick={() => setRows((prev) => [...prev, { type: '', workflow: '' }])}
          >
            <Plus className="h-3 w-3" />
            Add mapping
          </button>
        </div>

        <div className="flex items-center gap-3">
          <button
            className="shell-action bg-primary/10 text-primary hover:bg-primary/20 disabled:opacity-50"
            onClick={() => void save()}
            disabled={saving}
          >
            <Save className="h-3.5 w-3.5" />
            {saving ? 'Saving…' : 'Save binding'}
          </button>
          {feedback && (
            <span
              className={`text-xs ${
                feedback.type === 'success' ? 'text-success-foreground' : 'text-error-foreground'
              }`}
            >
              {feedback.message}
            </span>
          )}
        </div>
      </div>
    </SectionCard>
  );
}
