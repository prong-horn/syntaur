import { useState } from 'react';
import { RotateCcw } from 'lucide-react';
import { SectionCard } from '../components/SectionCard';
import {
  DENSITIES,
  SORT_DIRECTIONS,
  SORT_FIELDS,
  VIEW_MODES,
  type Density,
  type SortDirection,
  type SortField,
  type ViewMode,
} from '@shared/view-prefs-schema';
import { resetViewPrefs, saveGlobalViewPrefs, useViewPrefsFile } from '../hooks/useViewPrefs';

const VIEW_LABEL: Record<ViewMode, string> = {
  kanban: 'Kanban',
  list: 'List',
  table: 'Table',
};

const DENSITY_LABEL: Record<Density, string> = {
  comfortable: 'Comfortable',
  compact: 'Compact',
};

const SORT_FIELD_LABEL: Record<SortField, string> = {
  title: 'Title',
  status: 'Status',
  priority: 'Priority',
  assignee: 'Assignee',
  dependencies: 'Dependencies',
  updated: 'Updated',
};

const DIRECTION_LABEL: Record<SortDirection, string> = {
  asc: 'Ascending',
  desc: 'Descending',
};

export function ViewDefaultsSection() {
  const file = useViewPrefsFile();
  const global = file.global;
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  function flash(type: 'success' | 'error', message: string) {
    setFeedback({ type, message });
    setTimeout(() => setFeedback(null), 2000);
  }

  async function update<K extends keyof typeof global>(key: K, value: (typeof global)[K]) {
    if (global[key] === value) return;
    setSaving(true);
    try {
      await saveGlobalViewPrefs({ [key]: value } as Partial<typeof global>);
      flash('success', 'Saved');
    } catch (err) {
      flash('error', err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  }

  async function handleReset() {
    if (!file.custom) return;
    setSaving(true);
    try {
      await resetViewPrefs();
      flash('success', 'Reset to defaults');
    } catch (err) {
      flash('error', err instanceof Error ? err.message : 'Failed to reset');
    } finally {
      setSaving(false);
    }
  }

  return (
    <SectionCard
      title="View defaults"
      description="Defaults for the assignments board, list, and table views. Per-project overrides are saved automatically as you use them."
      actions={
        file.custom ? (
          <button
            type="button"
            className="shell-action text-xs"
            onClick={handleReset}
            disabled={saving}
          >
            <RotateCcw className="h-3 w-3" />
            Reset
          </button>
        ) : undefined
      }
    >
      {feedback && (
        <div
          className={`mb-3 rounded-md border px-3 py-1.5 text-xs ${
            feedback.type === 'success'
              ? 'border-success-foreground/30 bg-success text-success-foreground'
              : 'border-error-foreground/30 bg-error text-error-foreground'
          }`}
        >
          {feedback.message}
        </div>
      )}

      <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Default view
          </dt>
          <dd className="mt-1.5 inline-flex rounded-md border border-border/60 p-0.5">
            {VIEW_MODES.map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => update('defaultView', v)}
                disabled={saving}
                aria-pressed={global.defaultView === v}
                className={`px-3 py-1 text-xs ${
                  global.defaultView === v
                    ? 'rounded bg-foreground text-background'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {VIEW_LABEL[v]}
              </button>
            ))}
          </dd>
        </div>

        <div>
          <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Density
          </dt>
          <dd className="mt-1.5 inline-flex rounded-md border border-border/60 p-0.5">
            {DENSITIES.map((d) => (
              <button
                key={d}
                type="button"
                onClick={() => update('density', d)}
                disabled={saving}
                aria-pressed={global.density === d}
                className={`px-3 py-1 text-xs ${
                  global.density === d
                    ? 'rounded bg-foreground text-background'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {DENSITY_LABEL[d]}
              </button>
            ))}
          </dd>
        </div>

        <div>
          <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Sort by
          </dt>
          <dd className="mt-1.5">
            <select
              value={global.sortField}
              onChange={(e) => update('sortField', e.target.value as SortField)}
              disabled={saving}
              className="editor-input max-w-[220px]"
            >
              {SORT_FIELDS.map((f) => (
                <option key={f} value={f}>{SORT_FIELD_LABEL[f]}</option>
              ))}
            </select>
          </dd>
        </div>

        <div>
          <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Direction
          </dt>
          <dd className="mt-1.5 inline-flex rounded-md border border-border/60 p-0.5">
            {SORT_DIRECTIONS.map((d) => (
              <button
                key={d}
                type="button"
                onClick={() => update('sortDirection', d)}
                disabled={saving}
                aria-pressed={global.sortDirection === d}
                className={`px-3 py-1 text-xs ${
                  global.sortDirection === d
                    ? 'rounded bg-foreground text-background'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {DIRECTION_LABEL[d]}
              </button>
            ))}
          </dd>
        </div>
      </dl>
    </SectionCard>
  );
}
