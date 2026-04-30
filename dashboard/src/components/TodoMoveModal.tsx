import { useEffect, useMemo, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './ui/dialog';
import { moveTodo, type MoveTarget } from '../hooks/useTodos';
import { moveProjectTodo } from '../hooks/useProjectTodos';
import type { ProjectSummary } from '../hooks/useProjects';

export type MoveSourceScope =
  | { kind: 'workspace'; workspace: string }
  | { kind: 'project'; projectId: string };

interface TodoMoveModalProps {
  open: boolean;
  selectedIds: string[];
  scope: MoveSourceScope;
  onOpenChange: (open: boolean) => void;
  onDone: () => void;
}

type TargetKind = 'workspace' | 'project' | 'global';

interface MoveResult {
  succeeded: string[];
  failed: { id: string; error: string }[];
}

export function TodoMoveModal({ open, selectedIds, scope, onOpenChange, onDone }: TodoMoveModalProps) {
  const [targetKind, setTargetKind] = useState<TargetKind>('project');
  const [targetWorkspace, setTargetWorkspace] = useState('');
  const [targetProject, setTargetProject] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<MoveResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);

  useEffect(() => {
    if (!open) {
      setTargetKind('project');
      setTargetWorkspace('');
      setTargetProject('');
      setResult(null);
      setError(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch('/api/projects');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as ProjectSummary[];
        if (!cancelled) setProjects(data.filter((p) => !p.archived));
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => { cancelled = true; };
  }, [open]);

  const projectOptions = useMemo(() => {
    if (!projects) return [];
    if (scope.kind === 'project') return projects.filter((p) => p.slug !== scope.projectId);
    return projects;
  }, [projects, scope]);

  function buildTarget(): MoveTarget | string {
    if (targetKind === 'global') return { global: true };
    if (targetKind === 'workspace') {
      const ws = targetWorkspace.trim();
      if (!ws) return 'Workspace name is required.';
      return { workspace: ws };
    }
    if (!targetProject) return 'Pick a target project.';
    return { project: targetProject };
  }

  async function moveOne(id: string, to: MoveTarget): Promise<{ ok: true } | { ok: false; error: string }> {
    try {
      if (scope.kind === 'workspace') await moveTodo(scope.workspace, id, to);
      else await moveProjectTodo(scope.projectId, id, to);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const built = buildTarget();
    if (typeof built === 'string') { setError(built); return; }

    setSubmitting(true);
    setResult(null);

    const succeeded: string[] = [];
    const failed: { id: string; error: string }[] = [];
    // Sequential: server holds two locks per request; parallelizing risks
    // the same lock pair being reordered for different items in the bulk.
    for (const id of selectedIds) {
      // eslint-disable-next-line no-await-in-loop
      const res = await moveOne(id, built);
      if (res.ok) succeeded.push(id);
      else failed.push({ id, error: res.error });
    }

    setSubmitting(false);

    // Always refetch on the parent so the page reflects partial successes.
    onDone();

    if (failed.length === 0) {
      onOpenChange(false);
    } else {
      // Keep modal open so the user can see which ids failed and why; clear
      // succeeded ids from selection by signaling onDone (parent handles it).
      setResult({ succeeded, failed });
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => (!submitting ? onOpenChange(next) : undefined)}>
      <DialogContent className="max-w-xl">
        <form onSubmit={handleSubmit} className="space-y-4">
          <DialogHeader>
            <DialogTitle>Move {selectedIds.length} todo{selectedIds.length === 1 ? '' : 's'}</DialogTitle>
            <DialogDescription>
              Move the selected todo{selectedIds.length === 1 ? '' : 's'} to a different scope. id, tags, branch, timestamps, and plan dir are preserved.
            </DialogDescription>
          </DialogHeader>

          <fieldset className="space-y-2" disabled={submitting}>
            <legend className="block text-xs font-medium uppercase tracking-[0.08em] text-muted-foreground mb-1">
              Target scope
            </legend>
            <ScopeRadio
              kind="project"
              checked={targetKind === 'project'}
              onChange={() => setTargetKind('project')}
              label="Project"
            />
            <ScopeRadio
              kind="workspace"
              checked={targetKind === 'workspace'}
              onChange={() => setTargetKind('workspace')}
              label="Workspace"
            />
            <ScopeRadio
              kind="global"
              checked={targetKind === 'global'}
              onChange={() => setTargetKind('global')}
              label="Global"
            />
          </fieldset>

          {targetKind === 'project' ? (
            <Field label="Target project">
              <select
                value={targetProject}
                onChange={(e) => setTargetProject(e.target.value)}
                disabled={submitting}
                className="editor-textarea w-full bg-background/95 font-sans"
              >
                <option value="">Select project...</option>
                {projectOptions.map((p) => (
                  <option key={p.slug} value={p.slug}>{p.title} ({p.slug})</option>
                ))}
              </select>
            </Field>
          ) : null}

          {targetKind === 'workspace' ? (
            <Field label="Target workspace name">
              <input
                type="text"
                value={targetWorkspace}
                onChange={(e) => setTargetWorkspace(e.target.value)}
                disabled={submitting}
                placeholder="e.g. syntaur"
                className="editor-textarea w-full bg-background/95 font-sans"
              />
            </Field>
          ) : null}

          {error ? <ErrorBanner message={error} /> : null}

          {result ? (
            <div className="rounded-md border border-warning-foreground/30 bg-warning px-3 py-2 text-sm text-warning-foreground space-y-1">
              <div className="font-medium">
                Moved {result.succeeded.length} of {selectedIds.length}; {result.failed.length} failed.
              </div>
              <ul className="text-xs space-y-0.5">
                {result.failed.map((f) => (
                  <li key={f.id}>[t:{f.id}] {f.error}</li>
                ))}
              </ul>
            </div>
          ) : null}

          <DialogFooter>
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              disabled={submitting}
              className="shell-action disabled:cursor-not-allowed disabled:opacity-50"
            >
              {result ? 'Close' : 'Cancel'}
            </button>
            {result === null ? (
              <button
                type="submit"
                disabled={submitting}
                className="shell-action bg-foreground text-background hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {submitting ? 'Moving...' : 'Move'}
              </button>
            ) : null}
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1.5">
      <span className="block text-xs font-medium uppercase tracking-[0.08em] text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

function ScopeRadio({ kind, checked, onChange, label }: { kind: TargetKind; checked: boolean; onChange: () => void; label: string }) {
  return (
    <label className="flex items-center gap-2 text-sm cursor-pointer">
      <input type="radio" name="move-target-kind" value={kind} checked={checked} onChange={onChange} />
      <span>{label}</span>
    </label>
  );
}

function ErrorBanner({ message }: { message: string }) {
  return (
    <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
      {message}
    </div>
  );
}
