import { useState } from 'react';
import { RotateCcw } from 'lucide-react';
import { SectionCard } from '../components/SectionCard';
import { useWorkspaces } from '../hooks/useProjects';
import {
  UNGROUPED_WORKSPACE,
  isWorkspaceHidden,
} from '@shared/workspace-visibility-schema';
import {
  useWorkspaceVisibilityConfig,
  saveWorkspaceVisibilityConfig,
  resetWorkspaceVisibilityConfig,
} from '../hooks/useWorkspaceVisibilityConfig';

interface Feedback {
  type: 'success' | 'error';
  message: string;
}

function workspaceLabel(name: string): string {
  return name === UNGROUPED_WORKSPACE ? 'Ungrouped' : name;
}

export function WorkspaceVisibilitySection() {
  const { data, loading, error, refetch } = useWorkspaces();
  const { hidden, custom } = useWorkspaceVisibilityConfig();
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<Feedback | null>(null);

  function flash(next: Feedback) {
    setFeedback(next);
    setTimeout(() => setFeedback(null), 2500);
  }

  const names = data
    ? [...data.workspaces, ...(data.hasUngrouped ? [UNGROUPED_WORKSPACE] : [])]
    : [];

  async function handleToggle(name: string, nextVisible: boolean) {
    // nextVisible === true → show (remove from blocklist); false → hide (add).
    const nextHidden = nextVisible
      ? hidden.filter((h) => h !== name)
      : [...hidden, name];
    setSaving(true);
    try {
      await saveWorkspaceVisibilityConfig(nextHidden);
      flash({
        type: 'success',
        message: nextVisible
          ? `Showing "${workspaceLabel(name)}" in the left nav.`
          : `Hiding "${workspaceLabel(name)}" from the left nav.`,
      });
    } catch (err) {
      flash({
        type: 'error',
        message: err instanceof Error ? err.message : 'Save failed.',
      });
    } finally {
      setSaving(false);
    }
  }

  async function handleReset() {
    setSaving(true);
    try {
      await resetWorkspaceVisibilityConfig();
      flash({ type: 'success', message: 'All workspaces shown in the left nav.' });
    } catch (err) {
      flash({
        type: 'error',
        message: err instanceof Error ? err.message : 'Reset failed.',
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <SectionCard
      title="Workspace visibility"
      description="Choose which workspaces appear in the left nav. Hidden workspaces stay fully reachable by direct URL — this only controls the sidebar."
      actions={
        custom ? (
          <button
            className="shell-action text-xs"
            onClick={handleReset}
            disabled={saving}
            type="button"
          >
            <RotateCcw className="h-3 w-3" />
            Show all
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

      {loading ? (
        <div className="text-sm text-muted-foreground">Loading workspaces…</div>
      ) : error ? (
        <div className="flex items-center gap-3 text-sm text-error-foreground">
          <span>Failed to load workspaces.</span>
          <button
            type="button"
            className="shell-action text-xs"
            onClick={refetch}
          >
            <RotateCcw className="h-3 w-3" />
            Retry
          </button>
        </div>
      ) : names.length === 0 ? (
        <div className="text-sm text-muted-foreground">No workspaces yet.</div>
      ) : (
        <ul className="flex flex-col divide-y divide-border/40">
          {names.map((name) => {
            const visible = !isWorkspaceHidden(name, hidden);
            return (
              <li
                key={name}
                className="flex items-center justify-between gap-3 py-2"
              >
                <span className="truncate text-sm" title={workspaceLabel(name)}>
                  {workspaceLabel(name)}
                  {name === UNGROUPED_WORKSPACE && (
                    <span className="ml-2 text-xs text-muted-foreground">
                      (standalone, ungrouped)
                    </span>
                  )}
                </span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={visible}
                  aria-label={`Show "${workspaceLabel(name)}" in the left nav`}
                  onClick={() => handleToggle(name, !visible)}
                  disabled={saving}
                  className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-60 ${
                    visible ? 'bg-primary' : 'bg-muted'
                  }`}
                >
                  <span
                    className={`pointer-events-none inline-block h-4 w-4 rounded-full bg-background shadow-sm ring-0 transition-transform ${
                      visible ? 'translate-x-4' : 'translate-x-0'
                    }`}
                  />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </SectionCard>
  );
}
