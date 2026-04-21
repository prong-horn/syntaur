import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Activity, CheckSquare, Square, Trash2 } from 'lucide-react';
import { CopyButton } from '../components/CopyButton';
import { useAgentSessions, useProjects, useWorkspacePrefix } from '../hooks/useProjects';
import { LoadingState } from '../components/LoadingState';
import { ErrorState } from '../components/ErrorState';
import { EmptyState } from '../components/EmptyState';
import { SearchInput } from '../components/SearchInput';
import { FilterBar } from '../components/FilterBar';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { formatDateTime, toTitleCase } from '../lib/format';
import type { AgentSession } from '../types';

type SessionSort =
  | 'started_desc'
  | 'started_asc'
  | 'duration_desc'
  | 'duration_asc'
  | 'assignment_asc'
  | 'agent_asc';

interface PendingDelete {
  sessionIds: string[];
  title: string;
  description: string;
  confirmLabel: string;
}

export function AgentSessionsPage() {
  const { workspace } = useParams<{ workspace?: string }>();
  const { data: projectsData } = useProjects();
  const { data, loading, error } = useAgentSessions();
const [search, setSearch] = useState('');
  const [startedFrom, setStartedFrom] = useState('');
  const [startedTo, setStartedTo] = useState('');
  const [sort, setSort] = useState<SessionSort>('started_desc');
  const [tick, setTick] = useState(0);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null);

  const hasActiveSessions = data?.sessions.some((session) => session.status === 'active') ?? false;
  useEffect(() => {
    if (!hasActiveSessions) {
      return;
    }

    const interval = window.setInterval(() => setTick((current) => current + 1), 30000);
    return () => window.clearInterval(interval);
  }, [hasActiveSessions]);

  // Prune stale selections when data changes
  useEffect(() => {
    setSelectedIds((prev) => {
      if (prev.size === 0) return prev;
      const validIds = new Set(data?.sessions.map((s) => s.sessionId) ?? []);
      const next = new Set([...prev].filter((id) => validIds.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [data]);

  const filteredSessions = useMemo(() => {
    if (!data) {
      return [];
    }
    if (workspace && !projectsData) return [];

    const query = search.trim().toLowerCase();
    const sessions = data.sessions.filter((session) => {
      if (workspace && projectsData) {
        const projectWorkspace = projectsData.find((m) => m.slug === session.projectSlug)?.workspace ?? null;
        if (workspace === '_ungrouped') {
          if (projectWorkspace !== null) return false;
        } else {
          if (projectWorkspace !== workspace) return false;
        }
      }

      const startedDay = toLocalDateKey(session.started);
      if (startedFrom && (!startedDay || startedDay < startedFrom)) {
        return false;
      }
      if (startedTo && (!startedDay || startedDay > startedTo)) {
        return false;
      }

      if (!query) {
        return true;
      }

      const haystack = [
        session.projectSlug ?? '',
        session.assignmentSlug ?? '',
        session.agent,
        session.sessionId,
        session.path,
        session.description ?? '',
        session.transcriptPath ?? '',
      ]
        .join(' ')
        .toLowerCase();

      return haystack.includes(query);
    });

    return [...sessions].sort((left, right) => compareSessions(left, right, sort));
  }, [data, search, sort, startedFrom, startedTo, tick, workspace, projectsData]);

  function toggleSelection(sessionId: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(sessionId)) next.delete(sessionId);
      else next.add(sessionId);
      return next;
    });
  }

  function toggleSelectAll() {
    if (selectedIds.size === filteredSessions.length && filteredSessions.length > 0) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(filteredSessions.map((s) => s.sessionId)));
    }
  }

  async function handleDelete(ids: string[]) {
    setDeleteError(null);
    setDeleting(true);
    try {
      const response = await fetch('/api/agent-sessions', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionIds: ids }),
      });

      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(payload?.error || `HTTP ${response.status}`);
      }

      setSelectedIds((prev) => new Set([...prev].filter((id) => !ids.includes(id))));
      setPendingDelete(null);
    } catch (mutationError) {
      setDeleteError((mutationError as Error).message);
    } finally {
      setDeleting(false);
    }
  }

  if (loading) return <LoadingState label="Loading agent sessions..." />;
  if (error) return <ErrorState error={error} />;
  if (!data) return null;

  const hasAnySessions = data.sessions.length > 0;

  return (
    <>
      <FilterBar>
        <SearchInput
          value={search}
          onChange={setSearch}
          placeholder="Search project, assignment, agent, session ID, path, or description"
        />
        <label className="flex min-w-[150px] flex-col gap-1 text-xs font-medium uppercase tracking-[0.08em] text-muted-foreground">
          Started From
          <input
            type="date"
            value={startedFrom}
            onChange={(event) => setStartedFrom(event.target.value)}
            className="editor-input min-w-[150px]"
          />
        </label>
        <label className="flex min-w-[150px] flex-col gap-1 text-xs font-medium uppercase tracking-[0.08em] text-muted-foreground">
          Started To
          <input
            type="date"
            value={startedTo}
            onChange={(event) => setStartedTo(event.target.value)}
            className="editor-input min-w-[150px]"
          />
        </label>
        <select value={sort} onChange={(event) => setSort(event.target.value as SessionSort)} className="editor-input max-w-[200px]">
          <option value="started_desc">Newest first</option>
          <option value="started_asc">Oldest first</option>
          <option value="assignment_asc">Assignment A-Z</option>
          <option value="agent_asc">Agent A-Z</option>
        </select>
      </FilterBar>

      {deleteError ? (
        <div className="mt-4 rounded-md border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700 dark:border-rose-900 dark:bg-rose-950/30 dark:text-rose-300">
          {deleteError}
        </div>
      ) : null}

      {selectedIds.size > 0 && (
        <div className="mt-4 flex items-center gap-3 rounded border border-border/40 bg-muted/30 px-4 py-2 text-sm">
          <span className="text-muted-foreground">
            {selectedIds.size} session{selectedIds.size !== 1 ? 's' : ''} selected
          </span>
          <button
            className="shell-action text-destructive"
            onClick={() =>
              setPendingDelete({
                sessionIds: [...selectedIds],
                title: `Delete ${selectedIds.size} selected session${selectedIds.size === 1 ? '' : 's'}?`,
                description: 'This removes the selected agent session records from the dashboard. This cannot be undone.',
                confirmLabel: selectedIds.size === 1 ? 'Delete Session' : 'Delete Sessions',
              })
            }
            disabled={deleting}
          >
            <Trash2 className="mr-1 inline h-3.5 w-3.5" />
            Delete Selected
          </button>
          <button
            className="shell-action"
            onClick={() => setSelectedIds(new Set())}
          >
            Clear Selection
          </button>
        </div>
      )}

      {!hasAnySessions ? (
        <EmptyState
          title="No agent sessions"
          description="No agent sessions have been registered yet. Use /grab-assignment or syntaur track-session to register one."
        />
      ) : filteredSessions.length === 0 ? (
        <EmptyState
          title="No agent sessions match these filters"
          description="Adjust the status, search term, date range, or sorting controls to show sessions again."
        />
      ) : (
        <div className="surface-panel mt-4 overflow-x-auto">
          <table className="w-full min-w-[1040px] text-sm">
            <thead>
              <tr className="border-b border-border/40 text-left text-xs uppercase tracking-wider text-muted-foreground">
                <th className="w-8 pb-2 pr-3">
                  <button onClick={toggleSelectAll} className="text-muted-foreground hover:text-foreground">
                    {selectedIds.size === filteredSessions.length && filteredSessions.length > 0
                      ? <CheckSquare className="h-4 w-4" />
                      : <Square className="h-4 w-4" />}
                  </button>
                </th>
                <th className="pb-2 pr-3">Project</th>
                <th className="pb-2 pr-3">Assignment</th>
                <th className="pb-2 pr-3">Description</th>
                <th className="pb-2 pr-3">Agent</th>
                <th className="pb-2 pr-3">Session ID</th>
                <th className="pb-2 pr-3">Started</th>
                <th className="pb-2 pr-3">Path</th>
                <th className="pb-2 pr-3">Transcript</th>
                <th className="w-8 pb-2"></th>
              </tr>
            </thead>
            <tbody>
              {filteredSessions.map((session) => (
                <SessionRow
                  key={session.sessionId}
                  session={session}
                  selected={selectedIds.has(session.sessionId)}
                  onToggle={() => toggleSelection(session.sessionId)}
                  onDelete={() =>
                    setPendingDelete({
                      sessionIds: [session.sessionId],
                      title: `Delete session ${session.sessionId.slice(0, 8)}...?`,
                      description: `Remove this ${session.agent} session record${session.assignmentSlug ? ` for ${session.assignmentSlug}` : ''}. This cannot be undone.`,
                      confirmLabel: 'Delete Session',
                    })
                  }
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      <ConfirmDialog
        open={pendingDelete !== null}
        title={pendingDelete?.title ?? 'Delete session?'}
        description={pendingDelete?.description ?? ''}
        confirmLabel={pendingDelete?.confirmLabel ?? 'Delete'}
        destructive
        loading={deleting}
        onOpenChange={(open) => {
          if (!open) {
            setPendingDelete(null);
          }
        }}
        onConfirm={async () => {
          if (!pendingDelete) {
            return;
          }

          await handleDelete(pendingDelete.sessionIds);
        }}
      />
    </>
  );
}

function SessionRow({
  session,
  selected,
  onToggle,
  onDelete,
}: {
  session: AgentSession;
  selected: boolean;
  onToggle: () => void;
  onDelete: () => void;
}) {
  const wsPrefix = useWorkspacePrefix();
  const shortId = session.sessionId.length > 12
    ? session.sessionId.slice(0, 8) + '...'
    : session.sessionId;
  const shortPath = session.path
    ? session.path.replace(/^\/Users\/[^/]+/, '~')
    : '\u2014';
  const shortTranscript = session.transcriptPath
    ? session.transcriptPath.replace(/^\/Users\/[^/]+/, '~')
    : '\u2014';

  return (
    <tr className="border-b border-border/20 last:border-0">
      <td className="py-2 pr-3">
        <button onClick={onToggle} className="text-muted-foreground hover:text-foreground">
          {selected ? <CheckSquare className="h-4 w-4" /> : <Square className="h-4 w-4" />}
        </button>
      </td>
      <td className="py-2 pr-3">
        {session.projectSlug ? (
          <Link to={`${wsPrefix}/projects/${session.projectSlug}`} className="text-primary hover:underline">
            {toTitleCase(session.projectSlug)}
          </Link>
        ) : session.assignmentSlug ? (
          <span className="rounded bg-neutral-800 px-1.5 py-0.5 text-[10px] font-mono uppercase tracking-wide text-neutral-300">
            Standalone
          </span>
        ) : (
          <span className="text-muted-foreground">&mdash;</span>
        )}
      </td>
      <td className="py-2 pr-3">
        {session.projectSlug && session.assignmentSlug ? (
          <Link
            to={`${wsPrefix}/projects/${session.projectSlug}/assignments/${session.assignmentSlug}`}
            className="text-primary hover:underline"
          >
            {toTitleCase(session.assignmentSlug)}
          </Link>
        ) : session.assignmentSlug ? (
          <Link
            to={`/assignments/${session.assignmentSlug}`}
            className="text-primary hover:underline font-mono"
          >
            {session.assignmentSlug}
          </Link>
        ) : (
          <span className="text-muted-foreground">&mdash;</span>
        )}
      </td>
      <td className="max-w-[200px] py-2 pr-3">
        {session.description ? (
          <span className="truncate text-xs text-muted-foreground" title={session.description}>
            {session.description.length > 60 ? session.description.slice(0, 57) + '...' : session.description}
          </span>
        ) : (
          <span className="text-muted-foreground">&mdash;</span>
        )}
      </td>
      <td className="py-2 pr-3">
        <span className="inline-flex items-center gap-1.5">
          <Activity className="h-3 w-3 text-muted-foreground" />
          {session.agent}
        </span>
      </td>
      <td className="py-2 pr-3">
        <span className="inline-flex items-center gap-1.5">
          <span className="font-mono text-xs text-muted-foreground" title={session.sessionId}>
            {shortId}
          </span>
          <CopyButton value={session.sessionId} />
        </span>
      </td>
      <td className="py-2 pr-3 text-xs text-muted-foreground">
        {formatDateTime(session.started)}
      </td>
      <td className="max-w-[240px] py-2 pr-3">
        <span className="inline-flex items-center gap-1.5">
          <span className="truncate text-xs text-muted-foreground" title={session.path}>
            {shortPath}
          </span>
          {session.path && <CopyButton value={session.path} />}
        </span>
      </td>
      <td className="max-w-[260px] py-2 pr-3">
        {session.transcriptPath ? (
          <span className="inline-flex items-center gap-1.5">
            <span
              className="truncate font-mono text-xs text-muted-foreground"
              title={session.transcriptPath}
            >
              {shortTranscript}
            </span>
            <CopyButton value={session.transcriptPath} />
          </span>
        ) : (
          <span className="text-muted-foreground">&mdash;</span>
        )}
      </td>
      <td className="py-2">
        <button
          onClick={onDelete}
          className="text-muted-foreground hover:text-destructive"
          title="Delete session"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </td>
    </tr>
  );
}

function toLocalDateKey(value: string): string | null {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function getDurationMinutes(session: AgentSession): number {
  const started = Date.parse(session.started);
  const ended = session.ended ? Date.parse(session.ended) : Date.now();
  if (Number.isNaN(started) || Number.isNaN(ended)) {
    return 0;
  }

  return Math.max(0, Math.floor((ended - started) / 60000));
}

function compareSessions(left: AgentSession, right: AgentSession, sort: SessionSort): number {
  switch (sort) {
    case 'started_asc':
      return left.started.localeCompare(right.started);
    case 'started_desc':
      return right.started.localeCompare(left.started);
    case 'duration_asc':
      return getDurationMinutes(left) - getDurationMinutes(right);
    case 'duration_desc':
      return getDurationMinutes(right) - getDurationMinutes(left);
    case 'assignment_asc':
      return (left.assignmentSlug ?? '').localeCompare(right.assignmentSlug ?? '')
        || (left.projectSlug ?? '').localeCompare(right.projectSlug ?? '');
    case 'agent_asc':
      return left.agent.localeCompare(right.agent)
        || (left.assignmentSlug ?? '').localeCompare(right.assignmentSlug ?? '');
    default:
      return 0;
  }
}
