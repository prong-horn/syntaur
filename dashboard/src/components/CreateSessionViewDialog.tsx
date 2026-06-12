import { useEffect, useMemo, useState } from 'react';
import type { SortField, SortDirection, SavedView } from '@shared/saved-views-schema';
import { toFilterValues } from '@shared/view-prefs-schema';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './ui/dialog';
import { MultiSelect, type MultiSelectOption } from './ui/MultiSelect';
import { DateRangeControl } from './ui/DateRangeControl';
import { useProjects, useAgentSessions } from '../hooks/useProjects';
import {
  DEFAULT_CREATE_SESSION_VIEW_STATE,
  minimizeDateRange,
  expandDateRange,
  type DateRangeUiState,
  type CreateSessionViewBuilderState,
} from '../lib/savedViews';

interface CreateSessionViewDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspace: string | null;
  initialView?: SavedView | null;
  onSubmit: (name: string, state: CreateSessionViewBuilderState) => Promise<void>;
}

const MAX_NAME_LENGTH = 80;

const SESSION_SORT_FIELDS: SortField[] = ['started', 'lastActivity', 'projectName', 'agentName'];

const SORT_FIELD_LABEL: Record<string, string> = {
  started: 'Start time',
  lastActivity: 'Last updated',
  projectName: 'Project',
  agentName: 'Agent',
};

const SESSION_STATUS_OPTIONS: MultiSelectOption[] = [
  { value: 'active', label: 'Active' },
  { value: 'ended', label: 'Ended' },
  { value: 'tracked', label: 'Tracked' },
  { value: 'untracked', label: 'Untracked' },
];

export function CreateSessionViewDialog({
  open,
  onOpenChange,
  // `workspace` is part of the props for symmetry with CreateViewDialog, but the
  // payload's workspace is supplied by the page/widget at build time, not here.
  initialView,
  onSubmit,
}: CreateSessionViewDialogProps) {
  const isEdit = !!initialView;
  const { data: projects } = useProjects();
  const { data: sessionsData } = useAgentSessions();

  const [name, setName] = useState('');
  const [project, setProject] = useState<string[]>([]);
  const [agent, setAgent] = useState<string[]>([]);
  const [sessionStatus, setSessionStatus] = useState<string[]>([]);
  const [dateRange, setDateRange] = useState<DateRangeUiState | null>(null);
  const [sortField, setSortField] = useState<SortField>(DEFAULT_CREATE_SESSION_VIEW_STATE.sortField);
  const [sortDirection, setSortDirection] = useState<SortDirection>(
    DEFAULT_CREATE_SESSION_VIEW_STATE.sortDirection,
  );
  const [limit, setLimit] = useState<string>('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function clearAll() {
    setProject([]);
    setAgent([]);
    setSessionStatus([]);
    setDateRange(null);
    setSortField(DEFAULT_CREATE_SESSION_VIEW_STATE.sortField);
    setSortDirection(DEFAULT_CREATE_SESSION_VIEW_STATE.sortDirection);
    setLimit('');
  }

  // Seed on open: prefill from initialView (edit) or reset to defaults (create).
  useEffect(() => {
    if (!open) return;
    setError(null);
    setSubmitting(false);
    if (initialView) {
      const f = initialView.config.filters;
      setName(initialView.name);
      setProject(toFilterValues(f.project));
      setAgent(toFilterValues(f.agent));
      setSessionStatus(toFilterValues(f.sessionStatus));
      setDateRange(expandDateRange(f.dateRange));
      setSortField(initialView.config.sortField);
      setSortDirection(initialView.config.sortDirection);
      setLimit(initialView.config.limit !== undefined ? String(initialView.config.limit) : '');
    } else {
      setName('');
      clearAll();
    }
  }, [open, initialView]);

  const projectOptions = useMemo<MultiSelectOption[]>(() => {
    const visible = projects ?? [];
    return [
      { value: '__standalone__', label: 'No project' },
      ...visible.map((p) => ({ value: p.slug, label: p.title })),
    ];
  }, [projects]);

  const agentOptions = useMemo<MultiSelectOption[]>(() => {
    const names = new Set<string>();
    for (const s of sessionsData?.sessions ?? []) {
      if (s.agent) names.add(s.agent);
    }
    return Array.from(names).sort().map((a) => ({ value: a, label: a }));
  }, [sessionsData]);

  const trimmedName = name.trim();
  const valid = trimmedName.length > 0 && trimmedName.length <= MAX_NAME_LENGTH;

  // Parse limit: empty string → undefined; otherwise parse as integer.
  const limitNum = limit.trim() === '' ? undefined : parseInt(limit.trim(), 10);
  const limitValid = limit.trim() === '' || (Number.isFinite(limitNum) && limitNum !== undefined && limitNum > 0 && limitNum <= 500);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <form
          className="space-y-4"
          onSubmit={async (event) => {
            event.preventDefault();
            if (!valid || !limitValid || submitting) return;
            setSubmitting(true);
            setError(null);

            const minimized = minimizeDateRange(dateRange);
            // Decision 6: always store the dateRange as targeting `started`
            const dateRangeWithStarted = minimized ? { ...minimized, field: 'started' as const } : undefined;

            const state: CreateSessionViewBuilderState = {
              filters: {
                project,
                agent,
                sessionStatus,
                dateRange: dateRangeWithStarted,
              },
              sortField,
              sortDirection,
              limit: limitNum,
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
            <DialogTitle>{isEdit ? 'Edit session view' : 'Create session view'}</DialogTitle>
          </DialogHeader>

          <div className="space-y-2">
            <label className="block text-xs font-medium text-muted-foreground" htmlFor="create-session-view-name">
              Name
            </label>
            <input
              id="create-session-view-name"
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

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Date range (session start)">
              <DateRangeControl className="w-full" value={dateRange} onChange={setDateRange} />
            </Field>
            <Field label="Project">
              <MultiSelect
                ariaLabel="Project filter"
                className="w-full"
                allLabel="All projects"
                options={projectOptions}
                value={project}
                onChange={setProject}
              />
            </Field>
            <Field label="Agent">
              <MultiSelect
                ariaLabel="Agent filter"
                className="w-full"
                allLabel="All agents"
                options={agentOptions}
                value={agent}
                onChange={setAgent}
              />
            </Field>
            <Field label="Session status">
              <MultiSelect
                ariaLabel="Session status filter"
                className="w-full"
                allLabel="All statuses"
                options={SESSION_STATUS_OPTIONS}
                value={sessionStatus}
                onChange={setSessionStatus}
              />
            </Field>
            <Field label="Sort by" className="sm:col-span-2">
              <div className="flex gap-2">
                <select
                  value={sortField}
                  onChange={(e) => setSortField(e.target.value as SortField)}
                  className="editor-input w-full"
                >
                  {SESSION_SORT_FIELDS.map((f) => (
                    <option key={f} value={f}>{SORT_FIELD_LABEL[f] ?? f}</option>
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
            <Field label="Max results" className="sm:col-span-2">
              <input
                type="number"
                min={1}
                max={500}
                value={limit}
                onChange={(e) => setLimit(e.target.value)}
                placeholder="No limit"
                className="editor-input w-full"
              />
              {!limitValid ? (
                <p className="mt-1 text-xs text-error-foreground">Limit must be between 1 and 500</p>
              ) : null}
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
                disabled={!valid || !limitValid || submitting}
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
