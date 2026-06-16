import { useEffect, useState } from 'react';
import { RotateCcw, Plus, X } from 'lucide-react';
import { SectionCard } from '../components/SectionCard';
import {
  ENTITY_KINDS,
  validateAliases,
  type DefaultScope,
  type EntityKind,
  type SearchConfig,
} from '@shared/search-schema';
import {
  useSearchConfig,
  saveSearchConfig,
  resetSearchConfig,
} from '../hooks/useSearchConfig';

const SCOPE_LABELS: Record<DefaultScope, string> = {
  all: 'Everything',
  assignment: 'Assignments',
  project: 'Projects',
  todo: 'Todos',
  server: 'Servers',
  playbook: 'Playbooks',
};

const SCOPE_OPTIONS: DefaultScope[] = ['all', ...ENTITY_KINDS];

interface AliasRow {
  prefix: string;
  kind: EntityKind;
}

interface Feedback {
  type: 'success' | 'error';
  message: string;
}

function toRows(aliases: Record<string, EntityKind>): AliasRow[] {
  return Object.entries(aliases).map(([prefix, kind]) => ({ prefix, kind }));
}

/** Assemble alias rows into a map, surfacing duplicate-prefix + schema errors. */
function validateRows(rows: AliasRow[]): { map: Record<string, EntityKind>; errors: string[] } {
  const errors: string[] = [];
  const map: Record<string, EntityKind> = {};
  const seen = new Set<string>();
  for (const { prefix, kind } of rows) {
    const p = prefix.trim();
    if (p === '') {
      errors.push('An alias prefix is empty.');
      continue;
    }
    if (seen.has(p)) {
      errors.push(`Duplicate prefix "${p}".`);
      continue;
    }
    seen.add(p);
    map[p] = kind;
  }
  const check = validateAliases(map);
  if (!check.ok) errors.push(...check.errors);
  return { map, errors };
}

export function SearchSection() {
  const { search, custom } = useSearchConfig();
  const [defaultScope, setDefaultScope] = useState<DefaultScope>(search.defaultScope);
  const [externalIds, setExternalIds] = useState<boolean>(search.externalIds);
  const [rows, setRows] = useState<AliasRow[]>(() => toRows(search.aliases));
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<Feedback | null>(null);

  // Re-sync from the server value when it changes (initial fetch / external save),
  // but never clobber in-progress local edits.
  const signature = JSON.stringify(search);
  useEffect(() => {
    if (dirty) return;
    setDefaultScope(search.defaultScope);
    setExternalIds(search.externalIds);
    setRows(toRows(search.aliases));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);

  const { map, errors } = validateRows(rows);

  function flash(next: Feedback) {
    setFeedback(next);
    setTimeout(() => setFeedback(null), 2500);
  }

  function addRow() {
    setRows((prev) => [...prev, { prefix: '', kind: 'assignment' }]);
    setDirty(true);
  }

  function removeRow(index: number) {
    setRows((prev) => prev.filter((_, i) => i !== index));
    setDirty(true);
  }

  function updateRow(index: number, patch: Partial<AliasRow>) {
    setRows((prev) => prev.map((row, i) => (i === index ? { ...row, ...patch } : row)));
    setDirty(true);
  }

  // Sync the local form straight from a server response and clear the dirty flag.
  // Done explicitly (not via the [signature] effect) because that effect early-
  // returns while dirty is true, and clearing dirty afterward would not re-fire it —
  // a reset-while-dirty would otherwise leave stale edits on screen.
  function syncFrom(cfg: SearchConfig) {
    setDefaultScope(cfg.defaultScope);
    setExternalIds(cfg.externalIds);
    setRows(toRows(cfg.aliases));
    setDirty(false);
  }

  async function handleSave() {
    if (errors.length > 0) return;
    setSaving(true);
    try {
      const res = await saveSearchConfig({ defaultScope, aliases: map, externalIds });
      syncFrom(res.search);
      flash({ type: 'success', message: 'Search settings saved.' });
    } catch (err) {
      flash({ type: 'error', message: err instanceof Error ? err.message : 'Save failed.' });
    } finally {
      setSaving(false);
    }
  }

  async function handleReset() {
    setSaving(true);
    try {
      const res = await resetSearchConfig();
      syncFrom(res.search);
      flash({ type: 'success', message: 'Reset to defaults.' });
    } catch (err) {
      flash({ type: 'error', message: err instanceof Error ? err.message : 'Reset failed.' });
    } finally {
      setSaving(false);
    }
  }

  const canSave = dirty && errors.length === 0 && !saving;

  return (
    <SectionCard
      title="Search"
      description="Customize the Cmd+K command palette: default scope, type-alias prefixes, and external-ID indexing."
      actions={
        custom ? (
          <button
            className="shell-action text-xs"
            onClick={handleReset}
            disabled={saving}
            type="button"
          >
            <RotateCcw className="h-3 w-3" />
            Reset to defaults
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

      <div className="space-y-5">
        {/* Default scope */}
        <label className="block text-sm">
          <span className="mb-1.5 block text-xs font-medium text-muted-foreground">
            Default scope
          </span>
          <select
            value={defaultScope}
            onChange={(e) => {
              setDefaultScope(e.target.value as DefaultScope);
              setDirty(true);
            }}
            disabled={saving}
            className="w-full max-w-sm rounded-md border border-border/60 bg-background px-3 py-1.5 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/30 disabled:opacity-60"
          >
            {SCOPE_OPTIONS.map((scope) => (
              <option key={scope} value={scope}>
                {SCOPE_LABELS[scope]}
              </option>
            ))}
          </select>
          <span className="mt-1 block text-xs text-muted-foreground">
            Searches with no type prefix are limited to this. An <code>all:</code> prefix (or empty
            box) always searches everything.
          </span>
        </label>

        {/* Alias editor */}
        <div className="text-sm">
          <span className="mb-1.5 block text-xs font-medium text-muted-foreground">
            Type-alias prefixes
          </span>
          <div className="space-y-2">
            {rows.map((row, i) => (
              <div key={i} className="flex items-center gap-2">
                <input
                  type="text"
                  value={row.prefix}
                  onChange={(e) => updateRow(i, { prefix: e.target.value })}
                  placeholder="prefix"
                  disabled={saving}
                  spellCheck={false}
                  className="w-24 rounded-md border border-border/60 bg-background px-2 py-1 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/30 disabled:opacity-60"
                />
                <span className="text-muted-foreground">→</span>
                <select
                  value={row.kind}
                  onChange={(e) => updateRow(i, { kind: e.target.value as EntityKind })}
                  disabled={saving}
                  className="rounded-md border border-border/60 bg-background px-2 py-1 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/30 disabled:opacity-60"
                >
                  {ENTITY_KINDS.map((kind) => (
                    <option key={kind} value={kind}>
                      {SCOPE_LABELS[kind]}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={() => removeRow(i)}
                  disabled={saving}
                  aria-label={`Remove alias ${row.prefix}`}
                  className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-60"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </div>
          <button
            type="button"
            onClick={addRow}
            disabled={saving}
            className="mt-2 inline-flex items-center gap-1 text-xs text-primary hover:underline disabled:opacity-60"
          >
            <Plus className="h-3 w-3" />
            Add alias
          </button>
        </div>

        {/* External IDs toggle */}
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            checked={externalIds}
            onChange={(e) => {
              setExternalIds(e.target.checked);
              setDirty(true);
            }}
            disabled={saving}
            className="mt-0.5"
          />
          <span>
            <span className="font-medium">Index external IDs</span>
            <span className="mt-0.5 block text-xs text-muted-foreground">
              Fold external IDs (e.g. Jira keys) into search and enable{' '}
              <code>jira:</code>/<code>externalid:</code> and bare-ID matching.
            </span>
          </span>
        </label>

        {/* Validation errors */}
        {dirty && errors.length > 0 && (
          <ul className="space-y-1 text-xs text-error-foreground">
            {errors.map((err, i) => (
              <li key={i}>{err}</li>
            ))}
          </ul>
        )}

        <div>
          <button
            type="button"
            onClick={handleSave}
            disabled={!canSave}
            className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Save search settings'}
          </button>
        </div>
      </div>
    </SectionCard>
  );
}
