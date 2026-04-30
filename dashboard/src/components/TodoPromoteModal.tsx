import { useEffect, useMemo, useState } from 'react';
import * as Tabs from '@radix-ui/react-tabs';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './ui/dialog';
import { promoteTodos, type PromoteBody } from '../hooks/useTodos';
import { promoteProjectTodos } from '../hooks/useProjectTodos';
import type { ProjectSummary, AssignmentSummary } from '../hooks/useProjects';
import { cn } from '../lib/utils';

export type PromoteScope = { kind: 'workspace'; workspace: string } | { kind: 'project'; projectId: string };

interface TodoPromoteModalProps {
  open: boolean;
  selectedIds: string[];
  scope: PromoteScope;
  onOpenChange: (open: boolean) => void;
  onDone: () => void;
}

type Priority = 'low' | 'medium' | 'high' | 'critical';

export function TodoPromoteModal({ open, selectedIds, scope, onOpenChange, onDone }: TodoPromoteModalProps) {
  const [tab, setTab] = useState<'new' | 'existing'>('new');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [projectsError, setProjectsError] = useState<string | null>(null);

  // New-assignment form
  const [newProject, setNewProject] = useState('');
  const [newTitle, setNewTitle] = useState('');
  const [newType, setNewType] = useState('');
  const [newPriority, setNewPriority] = useState<Priority | ''>('');

  // Existing-assignment form
  const [existingProject, setExistingProject] = useState('');
  const [existingAssignment, setExistingAssignment] = useState('');
  const [assignments, setAssignments] = useState<AssignmentSummary[] | null>(null);
  const [assignmentsLoading, setAssignmentsLoading] = useState(false);

  const titleRequired = selectedIds.length > 1;

  useEffect(() => {
    if (!open) {
      setTab('new');
      setError(null);
      setNewProject('');
      setNewTitle('');
      setNewType('');
      setNewPriority('');
      setExistingProject('');
      setExistingAssignment('');
      setAssignments(null);
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
        if (!cancelled) setProjectsError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => { cancelled = true; };
  }, [open]);

  useEffect(() => {
    if (!existingProject) { setAssignments(null); return; }
    let cancelled = false;
    setAssignmentsLoading(true);
    void (async () => {
      try {
        const res = await fetch(`/api/projects/${encodeURIComponent(existingProject)}/assignments`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as AssignmentSummary[];
        if (!cancelled) setAssignments(data);
      } catch {
        if (!cancelled) setAssignments([]);
      } finally {
        if (!cancelled) setAssignmentsLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [existingProject]);

  const projectOptions = useMemo(() => projects ?? [], [projects]);

  async function submitNew(e: React.FormEvent) {
    e.preventDefault();
    if (!newProject) { setError('Pick a target project.'); return; }
    if (titleRequired && !newTitle.trim()) { setError('Title is required when promoting multiple todos.'); return; }
    const body: PromoteBody = {
      todoIds: selectedIds,
      mode: 'new-assignment',
      target: { project: newProject },
      title: newTitle.trim() || undefined,
      type: newType.trim() || undefined,
      priority: newPriority || undefined,
    };
    await runMutation(body);
  }

  async function submitExisting(e: React.FormEvent) {
    e.preventDefault();
    if (!existingProject || !existingAssignment) { setError('Pick both project and assignment.'); return; }
    const body: PromoteBody = {
      todoIds: selectedIds,
      mode: 'to-assignment',
      target: { assignment: `${existingProject}/${existingAssignment}` },
    };
    await runMutation(body);
  }

  async function runMutation(body: PromoteBody) {
    setSubmitting(true);
    setError(null);
    try {
      if (scope.kind === 'workspace') {
        await promoteTodos(scope.workspace, body);
      } else {
        await promoteProjectTodos(scope.projectId, body);
      }
      onDone();
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => (!submitting ? onOpenChange(next) : undefined)}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Promote {selectedIds.length} todo{selectedIds.length === 1 ? '' : 's'}</DialogTitle>
          <DialogDescription>
            Convert the selected todo{selectedIds.length === 1 ? '' : 's'} to an assignment. The source todo{selectedIds.length === 1 ? '' : 's'} will be marked completed.
          </DialogDescription>
        </DialogHeader>

        <Tabs.Root value={tab} onValueChange={(v) => setTab(v as 'new' | 'existing')}>
          <Tabs.List className="flex gap-2 rounded-md border border-border/70 bg-card/80 p-1 mb-4">
            <Tabs.Trigger
              value="new"
              className={cn(
                'inline-flex items-center gap-2 rounded-sm px-3 py-1.5 text-sm font-medium text-muted-foreground transition',
                'data-[state=active]:bg-foreground data-[state=active]:text-background',
              )}
            >
              New assignment
            </Tabs.Trigger>
            <Tabs.Trigger
              value="existing"
              className={cn(
                'inline-flex items-center gap-2 rounded-sm px-3 py-1.5 text-sm font-medium text-muted-foreground transition',
                'data-[state=active]:bg-foreground data-[state=active]:text-background',
              )}
            >
              Existing assignment
            </Tabs.Trigger>
          </Tabs.List>

          <Tabs.Content value="new">
            <form onSubmit={submitNew} className="space-y-4">
              <Field label="Target project">
                <ProjectSelect
                  value={newProject}
                  onChange={setNewProject}
                  projects={projectOptions}
                  error={projectsError}
                  disabled={submitting}
                />
              </Field>
              <Field label={titleRequired ? 'Title (required)' : 'Title (defaults to first todo)'}>
                <input
                  type="text"
                  value={newTitle}
                  onChange={(e) => setNewTitle(e.target.value)}
                  disabled={submitting}
                  className="editor-textarea w-full bg-background/95 font-sans"
                />
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Type">
                  <input
                    type="text"
                    value={newType}
                    onChange={(e) => setNewType(e.target.value)}
                    placeholder="feature"
                    disabled={submitting}
                    className="editor-textarea w-full bg-background/95 font-sans"
                  />
                </Field>
                <Field label="Priority">
                  <select
                    value={newPriority}
                    onChange={(e) => setNewPriority(e.target.value as Priority | '')}
                    disabled={submitting}
                    className="editor-textarea w-full bg-background/95 font-sans"
                  >
                    <option value="">—</option>
                    <option value="low">low</option>
                    <option value="medium">medium</option>
                    <option value="high">high</option>
                    <option value="critical">critical</option>
                  </select>
                </Field>
              </div>
              {error ? <ErrorBanner message={error} /> : null}
              <PromoteFooter onCancel={() => onOpenChange(false)} submitting={submitting} submitLabel="Promote" />
            </form>
          </Tabs.Content>

          <Tabs.Content value="existing">
            <form onSubmit={submitExisting} className="space-y-4">
              <Field label="Project">
                <ProjectSelect
                  value={existingProject}
                  onChange={(v) => { setExistingProject(v); setExistingAssignment(''); }}
                  projects={projectOptions}
                  error={projectsError}
                  disabled={submitting}
                />
              </Field>
              <Field label={assignmentsLoading ? 'Assignment (loading...)' : 'Assignment'}>
                <select
                  value={existingAssignment}
                  onChange={(e) => setExistingAssignment(e.target.value)}
                  disabled={submitting || !existingProject || assignmentsLoading}
                  className="editor-textarea w-full bg-background/95 font-sans"
                >
                  <option value="">{existingProject ? 'Select assignment...' : 'Pick a project first'}</option>
                  {(assignments ?? []).map((a) => (
                    <option key={a.slug} value={a.slug}>
                      {a.title} ({a.status})
                    </option>
                  ))}
                </select>
              </Field>
              {error ? <ErrorBanner message={error} /> : null}
              <PromoteFooter onCancel={() => onOpenChange(false)} submitting={submitting} submitLabel="Promote" />
            </form>
          </Tabs.Content>
        </Tabs.Root>
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

function ProjectSelect({
  value,
  onChange,
  projects,
  error,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  projects: ProjectSummary[];
  error: string | null;
  disabled?: boolean;
}) {
  if (error) return <div className="text-sm text-destructive">Failed to load projects: {error}</div>;
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled}
      className="editor-textarea w-full bg-background/95 font-sans"
    >
      <option value="">Select project...</option>
      {projects.map((p) => (
        <option key={p.slug} value={p.slug}>
          {p.title} ({p.slug})
        </option>
      ))}
    </select>
  );
}

function ErrorBanner({ message }: { message: string }) {
  return (
    <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
      {message}
    </div>
  );
}

function PromoteFooter({
  onCancel,
  submitting,
  submitLabel,
}: {
  onCancel: () => void;
  submitting: boolean;
  submitLabel: string;
}) {
  return (
    <DialogFooter>
      <button
        type="button"
        onClick={onCancel}
        disabled={submitting}
        className="shell-action disabled:cursor-not-allowed disabled:opacity-50"
      >
        Cancel
      </button>
      <button
        type="submit"
        disabled={submitting}
        className="shell-action bg-foreground text-background hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {submitting ? 'Submitting...' : submitLabel}
      </button>
    </DialogFooter>
  );
}
