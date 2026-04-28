import { useState, useEffect, useCallback } from 'react';
import { Cloud, Download, Upload, Save } from 'lucide-react';
import { SectionCard } from './SectionCard';

const VALID_CATEGORIES = ['projects', 'playbooks', 'todos', 'servers', 'config'] as const;
type Category = (typeof VALID_CATEGORIES)[number];

interface BackupStatus {
  repo: string | null;
  categories: string;
  lastBackup: string | null;
  lastRestore: string | null;
  locked: boolean;
}

function parseCategories(csv: string): Set<Category> {
  const set = new Set<Category>();
  for (const part of csv.split(',').map((s) => s.trim())) {
    if ((VALID_CATEGORIES as readonly string[]).includes(part)) {
      set.add(part as Category);
    }
  }
  return set;
}

function formatTimestamp(iso: string | null): string {
  if (!iso) return 'never';
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

export function BackupSection() {
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<BackupStatus | null>(null);
  const [repo, setRepo] = useState('');
  const [selected, setSelected] = useState<Set<Category>>(new Set(VALID_CATEGORIES));
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState<'push' | 'pull' | null>(null);
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/backup');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: BackupStatus = await res.json();
      setStatus(data);
      setRepo(data.repo ?? '');
      setSelected(parseCategories(data.categories));
      setDirty(false);
    } catch (error) {
      setFeedback({
        type: 'error',
        message: `Failed to load backup config: ${error instanceof Error ? error.message : String(error)}`,
      });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  function toggleCategory(cat: Category) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat);
      else next.add(cat);
      return next;
    });
    setDirty(true);
  }

  async function saveConfig() {
    setSaving(true);
    setFeedback(null);
    try {
      const categoriesArr = Array.from(selected);
      const res = await fetch('/api/backup/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repo: repo.trim() || null, categories: categoriesArr }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setStatus(data);
      setDirty(false);
      setFeedback({ type: 'success', message: 'Backup configuration saved.' });
    } catch (error) {
      setFeedback({
        type: 'error',
        message: `Save failed: ${error instanceof Error ? error.message : String(error)}`,
      });
    } finally {
      setSaving(false);
    }
  }

  async function runBackup() {
    setRunning('push');
    setFeedback(null);
    try {
      const res = await fetch('/api/backup/push', { method: 'POST' });
      const data = await res.json();
      if (!res.ok || data.success === false) {
        throw new Error(data.error || data.message || `HTTP ${res.status}`);
      }
      setFeedback({ type: 'success', message: data.message || 'Backup complete.' });
      await load();
    } catch (error) {
      setFeedback({
        type: 'error',
        message: `Backup failed: ${error instanceof Error ? error.message : String(error)}`,
      });
    } finally {
      setRunning(null);
    }
  }

  async function runRestore() {
    const ok = window.confirm(
      'Restore will overwrite local files for the selected categories with the contents of the GitHub repo. This cannot be undone. Continue?',
    );
    if (!ok) return;
    setRunning('pull');
    setFeedback(null);
    try {
      const res = await fetch('/api/backup/pull', { method: 'POST' });
      const data = await res.json();
      if (!res.ok || data.success === false) {
        throw new Error(data.error || data.message || `HTTP ${res.status}`);
      }
      setFeedback({ type: 'success', message: data.message || 'Restore complete.' });
      await load();
    } catch (error) {
      setFeedback({
        type: 'error',
        message: `Restore failed: ${error instanceof Error ? error.message : String(error)}`,
      });
    } finally {
      setRunning(null);
    }
  }

  if (loading) {
    return (
      <SectionCard title="GitHub Backup" description="Back up Syntaur files to a GitHub repository">
        <p className="text-sm text-muted-foreground">Loading...</p>
      </SectionCard>
    );
  }

  const canRun = Boolean(repo.trim()) && selected.size > 0 && !running && !dirty;

  return (
    <SectionCard
      title="GitHub Backup"
      description="Back up Syntaur files to a GitHub repository and restore from it"
    >
      <div className="space-y-4">
        {feedback && (
          <div
            className={`rounded-lg border px-4 py-2 text-sm ${
              feedback.type === 'success'
                ? 'border-success-foreground/30 bg-success text-success-foreground'
                : 'border-error-foreground/30 bg-error text-error-foreground'
            }`}
          >
            {feedback.message}
          </div>
        )}

        <div className="space-y-2">
          <label className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Repository URL
          </label>
          <input
            type="text"
            value={repo}
            onChange={(e) => {
              setRepo(e.target.value);
              setDirty(true);
            }}
            placeholder="git@github.com:you/syntaur-backup.git"
            className="editor-input w-full text-sm"
          />
          <p className="text-xs text-muted-foreground">
            SSH or HTTPS URL. Requires <code className="rounded bg-muted px-1">git</code> installed and credentials configured locally.
          </p>
        </div>

        <div className="space-y-2">
          <label className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Categories to back up
          </label>
          <div className="flex flex-wrap gap-2">
            {VALID_CATEGORIES.map((cat) => {
              const active = selected.has(cat);
              return (
                <button
                  key={cat}
                  type="button"
                  onClick={() => toggleCategory(cat)}
                  className={`shell-action text-xs ${
                    active
                      ? 'bg-primary/10 text-primary hover:bg-primary/20'
                      : 'bg-muted/30 text-muted-foreground hover:bg-muted/60'
                  }`}
                >
                  <span
                    className={`mr-1 inline-block h-2 w-2 rounded-full ${active ? 'bg-primary' : 'bg-muted-foreground/40'}`}
                  />
                  {cat}
                </button>
              );
            })}
          </div>
        </div>

        <div className="grid grid-cols-1 gap-2 text-xs text-muted-foreground sm:grid-cols-2">
          <div>
            <span className="font-medium text-foreground">Last backup: </span>
            {formatTimestamp(status?.lastBackup ?? null)}
          </div>
          <div>
            <span className="font-medium text-foreground">Last restore: </span>
            {formatTimestamp(status?.lastRestore ?? null)}
          </div>
          {status?.locked && (
            <div className="sm:col-span-2 text-warning-foreground">
              ⚠ A backup operation is in progress or the lock file is stale.
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-3 pt-2">
          <button
            className="shell-action bg-primary/10 text-primary hover:bg-primary/20"
            onClick={saveConfig}
            disabled={saving || !dirty}
          >
            <Save className="h-3.5 w-3.5" />
            {saving ? 'Saving...' : 'Save Config'}
          </button>
          <button
            className="shell-action"
            onClick={runBackup}
            disabled={!canRun}
            title={!canRun ? (dirty ? 'Save config first' : 'Set repo and pick categories') : 'Back up now'}
          >
            <Upload className="h-3.5 w-3.5" />
            {running === 'push' ? 'Backing up...' : 'Back Up Now'}
          </button>
          <button
            className="shell-action"
            onClick={runRestore}
            disabled={!canRun}
            title={!canRun ? (dirty ? 'Save config first' : 'Set repo and pick categories') : 'Restore from backup'}
          >
            <Download className="h-3.5 w-3.5" />
            {running === 'pull' ? 'Restoring...' : 'Restore'}
          </button>
          {dirty && <span className="text-xs text-muted-foreground">Unsaved changes</span>}
        </div>

        <p className="flex items-start gap-2 rounded-md border border-border/40 bg-muted/20 p-3 text-xs text-muted-foreground">
          <Cloud className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            Restore never overwrites <code className="rounded bg-muted px-1">config.md</code> (would clobber backup settings). The
            agent sessions database is not backed up — only markdown files.
          </span>
        </p>
      </div>
    </SectionCard>
  );
}
