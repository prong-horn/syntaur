import { useEffect, useMemo, useState } from 'react';
import type { ViewMode, SortField, SortDirection, SavedView } from '@shared/saved-views-schema';
import { VIEW_MODES, SORT_FIELDS, toFilterValues } from '@shared/view-prefs-schema';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './ui/dialog';
import { MultiSelect, type MultiSelectOption } from './ui/MultiSelect';
import { DateRangeControl } from './ui/DateRangeControl';
import { ViewToggle } from './ViewToggle';
import { useStatusConfig, getStatusLabel } from '../hooks/useStatusConfig';
import { useTypesConfig, getTypeLabel } from '../hooks/useTypesConfig';
import { useProjects, useAssignmentsBoard } from '../hooks/useProjects';
import {
  PRIORITY_OPTIONS,
  DEFAULT_CREATE_VIEW_STATE,
  minimizeDateRange,
  expandDateRange,
  type DateRangeUiState,
  type CreateViewBuilderState,
} from '../lib/savedViews';

interface CreateViewDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Workspace used to SCOPE the project/assignee/tag option lists. */
  workspace: string | null;
  /** When set, the dialog opens in edit mode prefilled from this view. */
  initialView?: SavedView | null;
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
  created: 'Created',
  updated: 'Updated',
};

export function CreateViewDialog({
  open,
  onOpenChange,
  workspace,
  initialView,
  onSubmit,
}: CreateViewDialogProps) {
  const isEdit = !!initialView;
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
  const [tags, setTags] = useState<string[]>([]);
  const [activity, setActivity] = useState<'all' | 'fresh' | 'stale'>('all');
  const [dateRange, setDateRange] = useState<DateRangeUiState | null>(null);
  const [search, setSearch] = useState('');
  const [sortField, setSortField] = useState<SortField>(DEFAULT_CREATE_VIEW_STATE.sortField);
  const [sortDirection, setSortDirection] = useState<SortDirection>(
    DEFAULT_CREATE_VIEW_STATE.sortDirection,
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function clearAll() {
    setViewMode(DEFAULT_CREATE_VIEW_STATE.viewMode);
    setStatus([]);
    setPriority([]);
    setType([]);
    setProject([]);
    setAssignee([]);
    setTags([]);
    setActivity('all');
    setDateRange(null);
    setSearch('');
    setSortField(DEFAULT_CREATE_VIEW_STATE.sortField);
    setSortDirection(DEFAULT_CREATE_VIEW_STATE.sortDirection);
  }

  // Seed on open: prefill from initialView (edit) or reset to defaults (create).
  useEffect(() => {
    if (!open) return;
    setError(null);
    setSubmitting(false);
    if (initialView) {
      const f = initialView.config.filters;
      setName(initialView.name);
      setViewMode(initialView.config.viewMode);
      setStatus(toFilterValues(f.status));
      setPriority(toFilterValues(f.priority));
      setType(toFilterValues(f.type));
      setProject(toFilterValues(f.project));
      setAssignee(toFilterValues(f.assignee));
      setTags(toFilterValues(f.tags));
      setActivity(f.activity ?? 'all');
      setDateRange(expandDateRange(f.dateRange));
      setSearch(f.search ?? '');
      setSortField(initialView.config.sortField);
      setSortDirection(initialView.config.sortDirection);
    } else {
      setName('');
      clearAll();
    }
  }, [open, initialView]);

  const scopeOf = (ws: string | null) => (item: { projectWorkspace?: string | null }) =>
    !ws ? true : ws === '_ungrouped' ? item.projectWorkspace === null : item.projectWorkspace === ws;

  const projectOptions = useMemo<MultiSelectOption[]>(() => {
    const inScope = (p: { workspace: string | null }) =>
      !workspace ? true : workspace === '_ungrouped' ? p.workspace === null : p.workspace === workspace;
    const visible = (projects ?? []).filter(inScope);
    return [
      { value: '__standalone__', label: 'No project' },
      ...visible.map((p) => ({ value: p.slug, label: p.title })),
    ];
  }, [projects, workspace]);

  const assigneeOptions = useMemo<MultiSelectOption[]>(() => {
    const names = new Set<string>();
    const inScope = scopeOf(workspace);
    for (const a of board?.assignments ?? []) {
      if (inScope(a) && a.assignee) names.add(a.assignee);
    }
    const opts: MultiSelectOption[] = [{ value: '__unassigned__', label: 'Unassigned' }];
    for (const n of Array.from(names).sort()) opts.push({ value: n, label: n });
    return opts;
  }, [board, workspace]);

  const tagOptions = useMemo<MultiSelectOption[]>(() => {
    const set = new Set<string>();
    const inScope = scopeOf(workspace);
    for (const a of board?.assignments ?? []) {
      if (inScope(a)) for (const t of a.tags ?? []) set.add(t);
    }
    return Array.from(set).sort().map((t) => ({ value: t, label: t }));
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
              filters: {
                status,
                priority,
                type,
                project,
                assignee,
                tags,
                activity,
                dateRange: minimizeDateRange(dateRange),
                search,
              },
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
            <DialogTitle>{isEdit ? 'Edit view' : 'Create view'}</DialogTitle>
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
            <ViewToggle value={viewMode} onChange={(v) => setViewMode(v as ViewMode)} options={viewModeOptions} />
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Status">
              <MultiSelect ariaLabel="Status filter" className="w-full" allLabel="All statuses" options={statusOptions} value={status} onChange={setStatus} />
            </Field>
            <Field label="Priority">
              <MultiSelect ariaLabel="Priority filter" className="w-full" allLabel="All priorities" options={priorityOptions} value={priority} onChange={setPriority} />
            </Field>
            <Field label="Type">
              <MultiSelect ariaLabel="Type filter" className="w-full" allLabel="All types" options={typeOptions} value={type} onChange={setType} />
            </Field>
            <Field label="Project">
              <MultiSelect ariaLabel="Project filter" className="w-full" allLabel="All projects" options={projectOptions} value={project} onChange={setProject} />
            </Field>
            <Field label="Assignee">
              <MultiSelect ariaLabel="Assignee filter" className="w-full" allLabel="All assignees" options={assigneeOptions} value={assignee} onChange={setAssignee} />
            </Field>
            <Field label="Tags">
              <MultiSelect ariaLabel="Tags filter" className="w-full" allLabel="Any tags" options={tagOptions} value={tags} onChange={setTags} />
            </Field>
            <Field label="Activity">
              <select
                value={activity}
                onChange={(e) => setActivity(e.target.value as 'all' | 'fresh' | 'stale')}
                className="editor-input w-full"
              >
                <option value="all">All activity</option>
                <option value="stale">Stale only</option>
                <option value="fresh">Fresh only</option>
              </select>
            </Field>
            <Field label="Date range">
              <DateRangeControl className="w-full" value={dateRange} onChange={setDateRange} />
            </Field>
            <Field label="Search" className="sm:col-span-2">
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Title / slug / project contains…"
                className="editor-input w-full"
              />
            </Field>
            <Field label="Sort by" className="sm:col-span-2">
              <div className="flex gap-2">
                <select value={sortField} onChange={(e) => setSortField(e.target.value as SortField)} className="editor-input w-full">
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
            </Field>
          </div>

          {error ? (
            <p className="text-xs text-error-foreground" role="alert">
              {error}
            </p>
          ) : null}

          <DialogFooter className="sm:justify-between">
            <button type="button" onClick={clearAll} className="shell-action" disabled={submitting}>
              Clear all
            </button>
            <div className="flex items-center gap-2">
              <button type="button" onClick={() => onOpenChange(false)} className="shell-action" disabled={submitting}>
                Cancel
              </button>
              <button
                type="submit"
                disabled={!valid || submitting}
                className="shell-action shell-action--cta disabled:opacity-50"
              >
                {submitting ? 'Saving…' : isEdit ? 'Save changes' : 'Create view'}
              </button>
            </div>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function Field({
  label,
  className,
  children,
}: {
  label: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <label className={`space-y-1 ${className ?? ''}`}>
      <span className="block text-xs font-medium text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}
