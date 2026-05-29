import { useEffect, useState } from 'react';
import type { ViewMode, SortField, SortDirection } from '@shared/saved-views-schema';
import { VIEW_MODES, SORT_FIELDS } from '@shared/view-prefs-schema';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './ui/dialog';
import { ViewToggle } from './ViewToggle';
import { useStatusConfig, getStatusLabel } from '../hooks/useStatusConfig';
import { useProjects } from '../hooks/useProjects';
import {
  PRIORITY_OPTIONS,
  DEFAULT_CREATE_VIEW_STATE,
  type CreateViewBuilderState,
} from '../lib/savedViews';

interface CreateViewDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Active workspace from the route; null on global /views. */
  workspace: string | null;
  /** Re-throws on failure so the dialog stays open and surfaces the error. */
  onSubmit: (name: string, state: CreateViewBuilderState) => Promise<void>;
}

const MAX_NAME_LENGTH = 80;

const VIEW_MODE_LABEL: Record<ViewMode, string> = {
  kanban: 'Kanban',
  list: 'List',
  table: 'Table',
};

const SORT_FIELD_LABEL: Record<SortField, string> = {
  title: 'Title',
  status: 'Status',
  priority: 'Priority',
  assignee: 'Assignee',
  dependencies: 'Dependencies',
  updated: 'Updated',
};

export function CreateViewDialog({
  open,
  onOpenChange,
  workspace,
  onSubmit,
}: CreateViewDialogProps) {
  const statusConfig = useStatusConfig();
  const { data: projects } = useProjects();

  const [name, setName] = useState('');
  const [viewMode, setViewMode] = useState<ViewMode>(DEFAULT_CREATE_VIEW_STATE.viewMode);
  const [status, setStatus] = useState('all');
  const [priority, setPriority] = useState('all');
  const [project, setProject] = useState('all');
  const [assignee, setAssignee] = useState('');
  const [activity, setActivity] = useState<'all' | 'fresh' | 'stale'>('all');
  const [sortField, setSortField] = useState<SortField>(DEFAULT_CREATE_VIEW_STATE.sortField);
  const [sortDirection, setSortDirection] = useState<SortDirection>(
    DEFAULT_CREATE_VIEW_STATE.sortDirection,
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset all builder state whenever the dialog (re)opens.
  useEffect(() => {
    if (open) {
      setName('');
      setViewMode(DEFAULT_CREATE_VIEW_STATE.viewMode);
      setStatus('all');
      setPriority('all');
      setProject('all');
      setAssignee('');
      setActivity('all');
      setSortField(DEFAULT_CREATE_VIEW_STATE.sortField);
      setSortDirection(DEFAULT_CREATE_VIEW_STATE.sortDirection);
      setError(null);
      setSubmitting(false);
    }
  }, [open]);

  // Project options follow the repo's `_ungrouped` sentinel semantics
  // (matching ProjectList / AssignmentsPage): show ungrouped projects on
  // /w/_ungrouped, workspace-matched projects on /w/:ws, all on global /views.
  const visibleProjects = (projects ?? []).filter((p) =>
    !workspace
      ? true
      : workspace === '_ungrouped'
        ? p.workspace === null
        : p.workspace === workspace,
  );

  // A concrete project routes Apply to ProjectDetail, which has no activity
  // filter and renders 'list' as 'kanban'. Hide those unsupported controls so a
  // user can't build a view that won't round-trip (buildCreateViewPayload also
  // coerces them defensively). 'No project'/'All' route to the global list.
  const concreteProject = project !== 'all' && project !== '__standalone__';
  useEffect(() => {
    if (concreteProject) {
      setViewMode((m) => (m === 'list' ? 'kanban' : m));
      setActivity('all');
    }
  }, [concreteProject]);

  const viewModeOptions = (concreteProject
    ? VIEW_MODES.filter((m) => m !== 'list')
    : VIEW_MODES
  ).map((m) => ({ value: m, label: VIEW_MODE_LABEL[m] }));

  const trimmedName = name.trim();
  const valid = trimmedName.length > 0 && trimmedName.length <= MAX_NAME_LENGTH;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <form
          className="space-y-4"
          onSubmit={async (event) => {
            event.preventDefault();
            if (!valid || submitting) return;
            setSubmitting(true);
            setError(null);
            const state: CreateViewBuilderState = {
              viewMode,
              filters: { status, priority, project, assignee, activity },
              sortField,
              sortDirection,
            };
            try {
              await onSubmit(trimmedName, state);
            } catch (err) {
              setError(err instanceof Error ? err.message : String(err));
              setSubmitting(false);
            }
          }}
        >
          <DialogHeader>
            <DialogTitle>Create view</DialogTitle>
          </DialogHeader>

          <div className="space-y-2">
            <label className="block text-xs font-medium text-muted-foreground" htmlFor="create-view-name">
              Name
            </label>
            <input
              id="create-view-name"
              type="text"
              value={name}
              autoFocus
              required
              maxLength={MAX_NAME_LENGTH}
              onChange={(e) => setName(e.target.value)}
              placeholder="View name"
              className="w-full rounded-md border border-border/70 bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </div>

          <div className="space-y-2">
            <span className="block text-xs font-medium text-muted-foreground">View mode</span>
            <ViewToggle
              value={viewMode}
              onChange={(v) => setViewMode(v as ViewMode)}
              options={viewModeOptions}
            />
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="space-y-1">
              <span className="block text-xs font-medium text-muted-foreground">Status</span>
              <select value={status} onChange={(e) => setStatus(e.target.value)} className="editor-input w-full">
                <option value="all">All statuses</option>
                {statusConfig.order.map((id) => (
                  <option key={id} value={id}>{getStatusLabel(statusConfig, id)}</option>
                ))}
              </select>
            </label>

            <label className="space-y-1">
              <span className="block text-xs font-medium text-muted-foreground">Priority</span>
              <select value={priority} onChange={(e) => setPriority(e.target.value)} className="editor-input w-full">
                <option value="all">All priorities</option>
                {PRIORITY_OPTIONS.map((p) => (
                  <option key={p} value={p} className="capitalize">{p}</option>
                ))}
              </select>
            </label>

            <label className="space-y-1">
              <span className="block text-xs font-medium text-muted-foreground">Project</span>
              <select value={project} onChange={(e) => setProject(e.target.value)} className="editor-input w-full">
                <option value="all">All projects</option>
                <option value="__standalone__">No project</option>
                {visibleProjects.map((p) => (
                  <option key={p.slug} value={p.slug}>{p.title}</option>
                ))}
              </select>
            </label>

            <label className="space-y-1">
              <span className="block text-xs font-medium text-muted-foreground">Assignee</span>
              <input
                type="text"
                value={assignee}
                onChange={(e) => setAssignee(e.target.value)}
                placeholder="Any assignee"
                className="editor-input w-full"
              />
            </label>

            <label className="space-y-1">
              <span className="block text-xs font-medium text-muted-foreground">Activity</span>
              <select
                value={activity}
                onChange={(e) => setActivity(e.target.value as 'all' | 'fresh' | 'stale')}
                className="editor-input w-full"
                disabled={concreteProject}
                title={concreteProject ? 'Not available when a single project is selected' : undefined}
              >
                <option value="all">All activity</option>
                <option value="stale">Stale only</option>
                <option value="fresh">Fresh only</option>
              </select>
              {concreteProject ? (
                <span className="block text-[11px] text-muted-foreground">
                  Not available for a single project.
                </span>
              ) : null}
            </label>

            <label className="space-y-1">
              <span className="block text-xs font-medium text-muted-foreground">Sort by</span>
              <div className="flex gap-2">
                <select
                  value={sortField}
                  onChange={(e) => setSortField(e.target.value as SortField)}
                  className="editor-input w-full"
                >
                  {SORT_FIELDS.map((f) => (
                    <option key={f} value={f}>{SORT_FIELD_LABEL[f]}</option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={() => setSortDirection((d) => (d === 'asc' ? 'desc' : 'asc'))}
                  className="shell-action shrink-0"
                  title={sortDirection === 'asc' ? 'Ascending' : 'Descending'}
                >
                  {sortDirection === 'asc' ? 'Asc' : 'Desc'}
                </button>
              </div>
            </label>
          </div>

          {error ? (
            <p className="text-xs text-error-foreground" role="alert">
              {error}
            </p>
          ) : null}

          <DialogFooter>
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              className="shell-action"
              disabled={submitting}
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!valid || submitting}
              className="shell-action bg-foreground text-background hover:opacity-90 disabled:opacity-50"
            >
              {submitting ? 'Creating…' : 'Create view'}
            </button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
