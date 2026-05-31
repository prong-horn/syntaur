import { useEffect, useMemo, useState } from 'react';
import type { ViewMode, SortField, SortDirection } from '@shared/saved-views-schema';
import { VIEW_MODES, SORT_FIELDS } from '@shared/view-prefs-schema';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './ui/dialog';
import { MultiSelect, type MultiSelectOption } from './ui/MultiSelect';
import { ViewToggle } from './ViewToggle';
import { useStatusConfig, getStatusLabel } from '../hooks/useStatusConfig';
import { useTypesConfig, getTypeLabel } from '../hooks/useTypesConfig';
import { useProjects, useAssignmentsBoard } from '../hooks/useProjects';
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
  const typesConfig = useTypesConfig();
  const { data: projects } = useProjects();
  const { data: board } = useAssignmentsBoard();

  const [name, setName] = useState('');
  const [viewMode, setViewMode] = useState<ViewMode>(DEFAULT_CREATE_VIEW_STATE.viewMode);
  const [status, setStatus] = useState<string[]>([]);
  const [priority, setPriority] = useState<string[]>([]);
  const [type, setType] = useState<string[]>([]);
  const [project, setProject] = useState<string[]>([]);
  const [assignee, setAssignee] = useState<string[]>([]);
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
      setStatus([]);
      setPriority([]);
      setType([]);
      setProject([]);
      setAssignee([]);
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
  const projectOptions = useMemo<MultiSelectOption[]>(() => {
    const visible = (projects ?? []).filter((p) =>
      !workspace
        ? true
        : workspace === '_ungrouped'
          ? p.workspace === null
          : p.workspace === workspace,
    );
    return [
      { value: '__standalone__', label: 'No project' },
      ...visible.map((p) => ({ value: p.slug, label: p.title })),
    ];
  }, [projects, workspace]);

  // Assignee options derived from the live board (scoped like the project list),
  // plus the Unassigned sentinel. Free-text rejected — derived options avoid
  // typo/no-match bugs (Decision 3); MultiSelect injects any orphan selection.
  const assigneeOptions = useMemo<MultiSelectOption[]>(() => {
    const names = new Set<string>();
    let hasUnassigned = false;
    for (const a of board?.assignments ?? []) {
      const inScope = !workspace
        ? true
        : workspace === '_ungrouped'
          ? a.projectWorkspace === null
          : a.projectWorkspace === workspace;
      if (!inScope) continue;
      if (a.assignee) names.add(a.assignee);
      else hasUnassigned = true;
    }
    const opts: MultiSelectOption[] = [];
    if (hasUnassigned) opts.push({ value: '__unassigned__', label: 'Unassigned' });
    for (const n of Array.from(names).sort()) opts.push({ value: n, label: n });
    return opts;
  }, [board, workspace]);

  const statusOptions = useMemo<MultiSelectOption[]>(
    () => statusConfig.order.map((id) => ({ value: id, label: getStatusLabel(statusConfig, id) })),
    [statusConfig],
  );
  const priorityOptions = useMemo<MultiSelectOption[]>(
    () => PRIORITY_OPTIONS.map((p) => ({ value: p, label: p[0].toUpperCase() + p.slice(1) })),
    [],
  );
  const typeOptions = useMemo<MultiSelectOption[]>(
    () => typesConfig.definitions.map((t) => ({ value: t.id, label: getTypeLabel(typesConfig, t.id) })),
    [typesConfig],
  );

  const viewModeOptions = VIEW_MODES.map((m) => ({ value: m, label: VIEW_MODE_LABEL[m] }));

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
              filters: { status, priority, type, project, assignee, activity },
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
              <MultiSelect
                ariaLabel="Status filter"
                className="w-full"
                allLabel="All statuses"
                options={statusOptions}
                value={status}
                onChange={setStatus}
              />
            </label>

            <label className="space-y-1">
              <span className="block text-xs font-medium text-muted-foreground">Priority</span>
              <MultiSelect
                ariaLabel="Priority filter"
                className="w-full"
                allLabel="All priorities"
                options={priorityOptions}
                value={priority}
                onChange={setPriority}
              />
            </label>

            <label className="space-y-1">
              <span className="block text-xs font-medium text-muted-foreground">Type</span>
              <MultiSelect
                ariaLabel="Type filter"
                className="w-full"
                allLabel="All types"
                options={typeOptions}
                value={type}
                onChange={setType}
              />
            </label>

            <label className="space-y-1">
              <span className="block text-xs font-medium text-muted-foreground">Project</span>
              <MultiSelect
                ariaLabel="Project filter"
                className="w-full"
                allLabel="All projects"
                options={projectOptions}
                value={project}
                onChange={setProject}
              />
            </label>

            <label className="space-y-1">
              <span className="block text-xs font-medium text-muted-foreground">Assignee</span>
              <MultiSelect
                ariaLabel="Assignee filter"
                className="w-full"
                allLabel="All assignees"
                options={assigneeOptions}
                value={assignee}
                onChange={setAssignee}
              />
            </label>

            <label className="space-y-1">
              <span className="block text-xs font-medium text-muted-foreground">Activity</span>
              <select
                value={activity}
                onChange={(e) => setActivity(e.target.value as 'all' | 'fresh' | 'stale')}
                className="editor-input w-full"
              >
                <option value="all">All activity</option>
                <option value="stale">Stale only</option>
                <option value="fresh">Fresh only</option>
              </select>
            </label>

            <label className="space-y-1 sm:col-span-2">
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
