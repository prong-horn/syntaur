import { Fragment, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Activity, CheckSquare, ChevronDown, ChevronRight, Square, Trash2 } from 'lucide-react';
import { CopyButton } from '../components/CopyButton';
import { CopyLaunchCommandButton } from '../components/CopyLaunchCommandButton';
import { SessionActionButtons } from '../components/SessionActionButtons';
import { cn } from '../lib/utils';
import { useAgentSessions, useWorkspacePrefix } from '../hooks/useProjects';
import { LoadingState } from '../components/LoadingState';
import { ErrorState } from '../components/ErrorState';
import { EmptyState } from '../components/EmptyState';
import { SearchInput } from '../components/SearchInput';
import { FilterBar } from '../components/FilterBar';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { formatCost, formatDateTime, formatTokens, toTitleCase } from '../lib/format';
import { headerCheckState, selectableSessionIds } from '@shared/session-select';
import type { AgentSessionWithLiveness } from '../types';
import { DEFAULT_SESSION_SORT, SESSION_SORTS, type SessionSort } from '@shared/session-sort';
import {
  ATTRIBUTION_LABELS,
  DEFAULT_SESSION_ATTRIBUTION,
  SESSION_ATTRIBUTIONS,
  type SessionAttribution,
} from '@shared/session-attribution';
import {
  ARCHIVED_FILTERS,
  ARCHIVED_LABELS,
  DEFAULT_ARCHIVED_FILTER,
  type ArchivedFilter,
} from '@shared/session-archived';

/**
 * Sort labels, keyed exhaustively by SessionSort so the dropdown cannot drift
 * from the sorts the server supports. It had drifted: duration_asc/duration_desc
 * existed in the type and in the comparator but were never offered here.
 */
/**
 * Column count of the sessions table header. The expanded detail row and the
 * pinned-group separator both span the full width, so they share this constant
 * rather than each hardcoding a number that silently drifts from the header.
 */
const SESSION_TABLE_COLUMN_COUNT = 12;

/**
 * Pinned, matching the SQL ordering EXACTLY.
 *
 * The server orders on `s.pinned_at IS NULL` with no archived term, so a
 * pinned-and-archived row genuinely does sort first in the Shown / Archived-only
 * views. An `&& !archivedAt` guard here — which an earlier revision had — would
 * disagree with that: the row would lead the table while rendering without the
 * pinned accent and without a group band. The predicate and the ORDER BY must
 * be the same rule or the grouping lies about the ordering.
 */
function isEffectivelyPinned(s: { pinnedAt?: string | null }): boolean {
  return Boolean(s.pinnedAt);
}

const SORT_LABELS: Record<SessionSort, string> = {
  started_desc: 'Newest first',
  started_asc: 'Oldest first',
  duration_desc: 'Longest first',
  duration_asc: 'Shortest first',
  assignment_asc: 'Assignment A-Z',
  agent_asc: 'Agent A-Z',
  spend_desc: 'Most expensive',
  tokens_desc: 'Most tokens',
};

const PAGE_SIZE_OPTIONS = [50, 100, 250, 500] as const;
const DEFAULT_PAGE_SIZE = 100;

/**
 * Hold a rapidly-changing value still for `delay` ms. Search is a server
 * round-trip now, so without this every keystroke is a request.
 */
function useDebounced<T>(value: T, delay: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setSettled(value), delay);
    return () => window.clearTimeout(timer);
  }, [value, delay]);
  return settled;
}

interface PendingDelete {
  sessionIds: string[];
  title: string;
  description: string;
  confirmLabel: string;
}

export function AgentSessionsPage() {
  const { workspace } = useParams<{ workspace?: string }>();
  const [search, setSearch] = useState('');
  const [startedFrom, setStartedFrom] = useState('');
  const [startedTo, setStartedTo] = useState('');
  const [sort, setSort] = useState<SessionSort>(DEFAULT_SESSION_SORT);
  // Defaults to real sessions only. Spend-only rows outnumber real sessions
  // roughly 3:1, so including them by default buries the ad-hoc sessions this
  // page is most useful for. Per-model spend lives on /usage.
  const [attribution, setAttribution] = useState<SessionAttribution>(DEFAULT_SESSION_ATTRIBUTION);
  const [archived, setArchived] = useState<ArchivedFilter>(DEFAULT_ARCHIVED_FILTER);
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);

  // Debounced search: filtering is a server round-trip now, so the raw input
  // must not become a request per keystroke.
  const debouncedSearch = useDebounced(search, 250);

  // Reset to the first page whenever the result set changes underneath the
  // user — otherwise narrowing a filter while on page 12 shows an empty table.
  useEffect(() => {
    setPage(0);
  }, [debouncedSearch, startedFrom, startedTo, sort, pageSize, workspace, attribution, archived]);

  const { data, loading, error, refetch } = useAgentSessions({
    // No `includeUsageOnly`: `attribution` supersedes it and is explicit about
    // which population is shown.
    page,
    pageSize,
    search: debouncedSearch || undefined,
    startedFrom: startedFrom || undefined,
    startedTo: startedTo || undefined,
    workspace: workspace ?? undefined,
    sort,
    attribution,
    archived,
  });
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null);

  // Live sessions keep their elapsed durations fresh by refetching the current
  // page every 30s. This used to bump a `tick` counter that the client-side
  // filter/sort memo depended on; that memo is gone, so a bare re-render would
  // now change nothing — durations are ranked server-side. Refetching the same
  // URL is what actually updates them.
  const hasActiveSessions = data?.sessions.some((session) => session.status === 'active') ?? false;
  useEffect(() => {
    if (!hasActiveSessions) {
      return;
    }

    const interval = window.setInterval(() => refetch(), 30000);
    return () => window.clearInterval(interval);
  }, [hasActiveSessions, refetch]);

  // Filtering, sorting, and paging all happen server-side now, so the response
  // IS the page. No client-side narrowing remains — that is what lets a filter
  // reach sessions far outside the loaded page.
  const pageSessions = data?.sessions ?? [];
  const pageMeta = data?.page;
  const totalCount = pageMeta?.totalCount ?? pageSessions.length;
  const pageCount = pageMeta?.pageCount ?? 1;

  // Clamp forward when a filter change shrinks the set beneath the current page.
  useEffect(() => {
    if (pageMeta && page > 0 && page > pageMeta.pageCount - 1) {
      setPage(pageMeta.pageCount - 1);
    }
  }, [pageMeta, page]);

  // NOTE: the old "prune stale selections whenever data changes" effect is gone
  // on purpose. It filtered `selectedIds` down to ids present in `data`, which
  // was safe when `data` was every session — but `data` is now ONE PAGE, so it
  // would discard every selection made on any other page the instant the user
  // paged away. Selection is instead pruned at the point of action (below, after
  // a successful delete), which is the only moment a stale id actually matters.

  // Header checkbox reflects THIS PAGE. Select-all deliberately does not reach
  // rows the user cannot see: `handleDelete` is destructive, and a header
  // checkbox that silently arms a delete across thousands of unseen rows is the
  // more dangerous default. The absolute count is always shown in the action bar.
  const headerState = useMemo(
    () => headerCheckState(pageSessions, selectedIds),
    [pageSessions, selectedIds],
  );

  // Bulk actions operate on selected AND VISIBLE rows only.
  //
  // Selection survives a filter change and a refetch, so an id can outlive the
  // row it points at — archive a selected session, or switch the archived
  // filter, and it is gone from the table while still in `selectedIds`. Acting
  // on the raw set would then delete a row the user can no longer see.
  // Intersecting here covers every filter (search, dates, workspace,
  // attribution, archived) and every mutation, rather than patching each
  // state transition separately.
  const actionableIds = useMemo(() => {
    const visible = new Set(selectableSessionIds(pageSessions));
    return [...selectedIds].filter((id) => visible.has(id));
  }, [pageSessions, selectedIds]);

  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  function toggleExpand(sessionId: string) {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(sessionId)) next.delete(sessionId);
      else next.add(sessionId);
      return next;
    });
  }

  function toggleSelection(sessionId: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(sessionId)) next.delete(sessionId);
      else next.add(sessionId);
      return next;
    });
  }

  function toggleSelectAll() {
    // Usage-only rows have no session record to act on, so they are never
    // selected — otherwise a bulk delete would target ids that do not exist.
    const eligible = selectableSessionIds(pageSessions);
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (headerState === 'all') {
        // Clear SUBTRACTS this page only. Replacing the set with an empty one
        // would silently drop selections the user built up on other pages.
        for (const id of eligible) next.delete(id);
      } else {
        // Select UNIONS this page into the existing selection, so paging
        // through and selecting accumulates rather than overwrites.
        for (const id of eligible) next.add(id);
      }
      return next;
    });
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

  // Mark-stopped is fire-and-forget — the server broadcasts
  // `agent-sessions-updated` after a successful PATCH and the WS-driven
  // refetch in useAgentSessions / useProjects picks up the new status.
  // Errors surface through the same error-state path as other mutations.
  async function handleMarkStopped(sessionId: string) {
    try {
      const response = await fetch(`/api/agent-sessions/${encodeURIComponent(sessionId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'stopped' }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        setDeleteError(payload?.error || `Failed to mark session stopped: HTTP ${response.status}`);
      }
    } catch (err) {
      setDeleteError((err as Error).message);
    }
  }

  // Curation (pin / archive / name) uses the same fire-and-forget contract as
  // mark-stopped: PATCH, then let the `agent-sessions-updated` broadcast drive
  // the refetch. No optimistic local state, matching this file's convention.
  async function patchCuration(
    sessionId: string,
    body: { pinned?: boolean; archived?: boolean; name?: string | null },
  ) {
    try {
      const response = await fetch(
        `/api/agent-sessions/${encodeURIComponent(sessionId)}/curation`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
      );
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        setDeleteError(payload?.error || `Failed to update session: HTTP ${response.status}`);
      }
    } catch (err) {
      setDeleteError((err as Error).message);
    }
  }

  // Rename uses window.prompt deliberately: this page has no inline-edit
  // affordance and no modal form component, and a name is a single short
  // string. Cancel (null) is a no-op; an empty string CLEARS the name, which
  // the server treats as releasing the row back to the auto-summarizer.
  function handleRename(sessionId: string) {
    const current = pageSessions.find((x) => x.sessionId === sessionId)?.description ?? '';
    const next = window.prompt('Name this session (leave blank to clear):', current);
    if (next === null) return;
    if (next.trim() === current.trim()) return;
    void patchCuration(sessionId, { name: next });
  }

  if (loading) return <LoadingState label="Loading agent sessions..." />;
  if (error) return <ErrorState error={error} />;
  if (!data) return null;

  // Whole-set emptiness, not page emptiness: an out-of-range page must not
  // claim no sessions were ever registered.
  const hasAnySessions = totalCount > 0 || data.sessions.length > 0;

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
        <select
          value={attribution}
          onChange={(event) => setAttribution(event.target.value as SessionAttribution)}
          aria-label="Filter sessions by attribution"
          className="editor-input max-w-[240px]"
        >
          {SESSION_ATTRIBUTIONS.map((value) => {
            const count = pageMeta?.attributionCounts?.[value];
            return (
              <option key={value} value={value}>
                {ATTRIBUTION_LABELS[value]}
                {count === undefined ? '' : ` (${count.toLocaleString()})`}
              </option>
            );
          })}
        </select>
        <select
          value={archived}
          onChange={(event) => setArchived(event.target.value as ArchivedFilter)}
          aria-label="Archived session visibility"
          className="editor-input max-w-[200px]"
        >
          {ARCHIVED_FILTERS.map((value) => (
            <option key={value} value={value}>
              {ARCHIVED_LABELS[value]}
            </option>
          ))}
        </select>
        <select
          value={sort}
          onChange={(event) => setSort(event.target.value as SessionSort)}
          aria-label="Sort sessions"
          className="editor-input max-w-[200px]"
        >
          {SESSION_SORTS.map((value) => (
            <option key={value} value={value}>
              {SORT_LABELS[value]}
            </option>
          ))}
        </select>
      </FilterBar>

      {deleteError ? (
        <div className="mt-4 rounded-md border border-error-foreground/30 bg-error px-4 py-3 text-sm text-error-foreground">
          {deleteError}
        </div>
      ) : null}

      {actionableIds.length > 0 && (
        <div className="mt-4 flex items-center gap-3 rounded border border-border/40 bg-muted/30 px-4 py-2 text-sm">
          <span className="text-muted-foreground">
            {actionableIds.length} session{actionableIds.length !== 1 ? 's' : ''} selected
          </span>
          <button
            className="shell-action text-destructive"
            onClick={() =>
              setPendingDelete({
                sessionIds: actionableIds,
                title: `Delete ${actionableIds.length} selected session${actionableIds.length === 1 ? '' : 's'}?`,
                description: 'This removes the selected agent session records from the dashboard. This cannot be undone.',
                confirmLabel: actionableIds.length === 1 ? 'Delete Session' : 'Delete Sessions',
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
      ) : totalCount === 0 ? (
        <EmptyState
          title="No agent sessions match these filters"
          description="Adjust the status, search term, date range, or sorting controls to show sessions again."
        />
      ) : (
        <div className="surface-panel mt-4 overflow-x-auto">
          <table className="w-full min-w-[1100px] table-fixed text-sm lg:min-w-[1420px]">
            <thead>
              <tr className="border-b border-border/40 text-left text-xs uppercase tracking-wider text-muted-foreground">
                <th className="w-[32px] pb-2 pr-3">
                  <button
                    onClick={toggleSelectAll}
                    className="text-muted-foreground hover:text-foreground disabled:opacity-40"
                    disabled={selectableSessionIds(pageSessions).length === 0}
                    title={headerState === 'all' ? 'Clear selection' : 'Select all'}
                  >
                    {headerState === 'all'
                      ? <CheckSquare className="h-4 w-4" />
                      : <Square className={headerState === 'some' ? 'h-4 w-4 text-primary' : 'h-4 w-4'} />}
                  </button>
                </th>
                <th className="w-[140px] pb-2 pr-3">Project</th>
                <th className="w-[160px] pb-2 pr-3">Assignment</th>
                <th className="w-[200px] pb-2 pr-3">Description</th>
                <th className="w-[110px] pb-2 pr-3">Agent</th>
                <th className="w-[90px] pb-2 pr-3 text-right">Cost</th>
                <th className="w-[100px] pb-2 pr-3 text-right">Tokens</th>
                <th className="hidden w-[130px] pb-2 pr-3 lg:table-cell">Session ID</th>
                <th className="w-[140px] pb-2 pr-3">Started</th>
                <th className="hidden w-[200px] pb-2 pr-3 lg:table-cell">Path</th>
                <th className="hidden w-[200px] pb-2 pr-3 lg:table-cell">Transcript</th>
                <th className="w-[40px] pb-2"></th>
              </tr>
            </thead>
            <tbody>
              {pageSessions.map((session, index) => (
                <Fragment key={session.sessionId}>
                  {/* Pinned rows lead the whole result set, so on page 0 the
                      group starts at the top. But there is no cap on pins: with
                      more of them than `pageSize` they overflow onto later
                      pages, and the pinned→unpinned boundary can fall anywhere.
                      So the band is derived from THIS page's rows on EVERY page
                      — a leading pinned row opens the group, and the boundary
                      closes it — rather than assuming page 0 holds them all. */}
                  {index === 0 && isEffectivelyPinned(session) && (
                    <tr className="bg-accent/30">
                      <td
                        colSpan={SESSION_TABLE_COLUMN_COUNT}
                        className="px-4 py-1 text-xs font-medium uppercase tracking-[0.08em] text-muted-foreground"
                      >
                        Pinned
                      </td>
                    </tr>
                  )}
                  {index > 0
                    && isEffectivelyPinned(pageSessions[index - 1])
                    && !isEffectivelyPinned(session) && (
                    <tr className="bg-accent/30">
                      <td
                        colSpan={SESSION_TABLE_COLUMN_COUNT}
                        className="px-4 py-1 text-xs font-medium uppercase tracking-[0.08em] text-muted-foreground"
                      >
                        All sessions
                      </td>
                    </tr>
                  )}
                  <SessionRow
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
                    onMarkStopped={handleMarkStopped}
                    onTogglePin={(id, pinned) => void patchCuration(id, { pinned })}
                    onToggleArchive={(id, archivedNext) =>
                      void patchCuration(id, { archived: archivedNext })
                    }
                    onRename={handleRename}
                    onCopyError={setDeleteError}
                    expanded={expandedIds.has(session.sessionId)}
                    onToggleExpand={() => toggleExpand(session.sessionId)}
                  />
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {totalCount > 0 && (
        <nav
          aria-label="Pagination"
          className="mt-3 flex flex-wrap items-center justify-between gap-3 text-sm text-muted-foreground"
        >
          <div>
            {pageCount > 1 ? (
              <>
                Page <span className="text-foreground">{Math.min(page, pageCount - 1) + 1}</span> of{' '}
                <span className="text-foreground">{pageCount}</span>
                {' · '}
              </>
            ) : null}
            <span className="text-foreground">{totalCount.toLocaleString()}</span>
            {totalCount === 1 ? ' session' : ' sessions'}
          </div>

          <div className="flex items-center gap-2">
            <label className="flex items-center gap-2">
              <span className="sr-only">Sessions per page</span>
              <select
                value={pageSize}
                onChange={(event) => setPageSize(Number(event.target.value))}
                aria-label="Sessions per page"
                className="rounded-md border border-border/70 bg-background/80 px-2 py-1 text-sm text-foreground"
              >
                {PAGE_SIZE_OPTIONS.map((size) => (
                  <option key={size} value={size}>
                    {size} / page
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              onClick={() => setPage((current) => Math.max(0, current - 1))}
              disabled={page <= 0}
              aria-label="Previous page"
              className="rounded-md border border-border/70 bg-background/80 px-3 py-1 text-sm text-foreground transition hover:bg-accent/40 disabled:opacity-40 disabled:hover:bg-background/80"
            >
              Previous
            </button>
            <button
              type="button"
              onClick={() => setPage((current) => Math.min(pageCount - 1, current + 1))}
              disabled={page >= pageCount - 1}
              aria-label="Next page"
              className="rounded-md border border-border/70 bg-background/80 px-3 py-1 text-sm text-foreground transition hover:bg-accent/40 disabled:opacity-40 disabled:hover:bg-background/80"
            >
              Next
            </button>
          </div>
        </nav>
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

          // Re-narrow at CONFIRM time, not just at open time. `pendingDelete`
          // is a snapshot; between opening the dialog and confirming, a row can
          // leave the view — archived from another session, or dropped by the
          // periodic refetch — and the snapshot would still delete it. Deleting
          // is irreversible, so it must act only on what is still visible.
          const visible = new Set(selectableSessionIds(pageSessions));
          const stillActionable = pendingDelete.sessionIds.filter((id) => visible.has(id));
          if (stillActionable.length === 0) {
            setPendingDelete(null);
            return;
          }
          await handleDelete(stillActionable);
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
  onMarkStopped,
  onTogglePin,
  onToggleArchive,
  onRename,
  onCopyError,
  expanded,
  onToggleExpand,
}: {
  session: AgentSessionWithLiveness;
  selected: boolean;
  onToggle: () => void;
  onDelete: () => void;
  onMarkStopped: (sessionId: string) => void;
  onTogglePin: (sessionId: string, pinned: boolean) => void;
  onToggleArchive: (sessionId: string, archived: boolean) => void;
  onRename: (sessionId: string) => void;
  onCopyError: (message: string) => void;
  expanded: boolean;
  onToggleExpand: () => void;
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
  const modelBreakdown = session.usage?.models.length
    ? session.usage.models
        .map((m) => `${m.model}: ${formatCost(m.cost)} \u00b7 ${formatTokens(m.tokens)} tokens`)
        .join('\n')
    : undefined;
  // The summary is what the expand row / description tooltip shows; a row is
  // only worth expanding when it has a summary or a usage breakdown.
  const canExpand = Boolean(session.summary) || Boolean(session.usage?.models.length);
  const isAuto = session.descriptionSource === 'auto';

  return (
    <>
    <tr
      className={cn(
        'border-b border-border/20 last:border-0',
        // A left accent marks the pinned group without adding a 13th column.
        isEffectivelyPinned(session) && 'border-l-2 border-l-primary bg-accent/20',
        // Archived rows are only visible in the Shown / Archived-only modes;
        // dimming keeps that state obvious at a glance.
        session.archivedAt && 'opacity-60',
      )}
    >
      <td className="py-2 pr-3">
        <button
          onClick={onToggle}
          className="text-muted-foreground hover:text-foreground disabled:opacity-30"
          disabled={session.usageOnly}
          title={session.usageOnly ? 'Usage-only rows cannot be selected' : undefined}
        >
          {selected ? <CheckSquare className="h-4 w-4" /> : <Square className="h-4 w-4" />}
        </button>
      </td>
      <td className="py-2 pr-3">
        {session.projectSlug ? (
          <Link
            to={`${wsPrefix}/projects/${session.projectSlug}`}
            className="block truncate text-primary hover:underline"
            title={toTitleCase(session.projectSlug)}
          >
            {toTitleCase(session.projectSlug)}
          </Link>
        ) : session.assignmentSlug ? (
          <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-mono uppercase tracking-wide text-muted-foreground">
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
            className="block truncate text-primary hover:underline"
            title={toTitleCase(session.assignmentSlug)}
          >
            {toTitleCase(session.assignmentSlug)}
          </Link>
        ) : session.assignmentSlug ? (
          <Link
            to={`/assignments/${session.assignmentSlug}`}
            className="block truncate font-mono text-primary hover:underline"
            title={session.assignmentSlug}
          >
            {session.assignmentSlug}
          </Link>
        ) : (
          <span className="text-muted-foreground">&mdash;</span>
        )}
      </td>
      <td className="py-2 pr-3">
        {session.description ? (
          <div
            className="flex items-center gap-1 truncate text-xs text-muted-foreground"
            // Hovering the description surfaces the fuller summary without an expand.
            title={session.summary ? `${session.description}\n\n${session.summary}` : session.description}
          >
            {isAuto && (
              <span
                className="shrink-0 rounded bg-primary/10 px-1 text-[9px] font-medium uppercase text-primary"
                title="Auto-generated from the session transcript"
              >
                auto
              </span>
            )}
            <span className="truncate">{session.description}</span>
          </div>
        ) : (
          <span className="text-muted-foreground">&mdash;</span>
        )}
      </td>
      <td className="py-2 pr-3">
        <span className="flex min-w-0 items-center gap-1.5">
          <Activity className="h-3 w-3 shrink-0 text-muted-foreground" />
          <span className="block min-w-0 truncate">{session.agent}</span>
          {session.usageOnly && (
            <span
              className="shrink-0 rounded bg-muted px-1 py-0.5 text-[9px] font-mono uppercase tracking-wide text-muted-foreground"
              title="Spend recorded by the usage collector for a session Syntaur never tracked — no transcript or actions available."
            >
              Usage only
            </span>
          )}
        </span>
      </td>
      <td className="py-2 pr-3 text-right text-xs tabular-nums" title={modelBreakdown}>
        {session.usage ? formatCost(session.usage.totalCost) : <span className="text-muted-foreground">&mdash;</span>}
      </td>
      <td className="py-2 pr-3 text-right text-xs tabular-nums text-muted-foreground" title={modelBreakdown}>
        {session.usage ? formatTokens(session.usage.totalTokens) : <span>&mdash;</span>}
      </td>
      <td className="hidden py-2 pr-3 lg:table-cell">
        <span className="flex min-w-0 items-center gap-1.5">
          {session.usageOnly ? (
            <span className="block min-w-0 truncate font-mono text-xs text-muted-foreground" title={session.sessionId}>
              {shortId}
            </span>
          ) : (
            <Link
              to={`${wsPrefix}/agent-sessions/${session.sessionId}`}
              className="block min-w-0 truncate font-mono text-xs text-muted-foreground hover:text-foreground hover:underline"
              title={session.sessionId}
            >
              {shortId}
            </Link>
          )}
          <CopyButton value={session.sessionId} />
          <CopyLaunchCommandButton
            sessionId={session.sessionId}
            disabled={!session.resumeSupported}
            disabledReason="Resume not supported for this agent"
            onError={(e) => onCopyError(e.message)}
            onNotice={(m) => onCopyError(m)}
          />
        </span>
      </td>
      <td className="py-2 pr-3 text-xs text-muted-foreground">
        <span className="truncate block">{formatDateTime(session.started)}</span>
      </td>
      <td className="hidden py-2 pr-3 lg:table-cell">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="block min-w-0 truncate text-xs text-muted-foreground" title={session.path}>
            {shortPath}
          </span>
          {session.path && <CopyButton value={session.path} />}
        </span>
      </td>
      <td className="hidden py-2 pr-3 lg:table-cell">
        {session.transcriptPath ? (
          <span className="flex min-w-0 items-center gap-1.5">
            <span
              className="block min-w-0 truncate font-mono text-xs text-muted-foreground"
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
        <div className="flex items-center gap-1.5">
          {canExpand && (
            <button
              onClick={onToggleExpand}
              className="text-muted-foreground hover:text-foreground"
              title={expanded ? 'Hide summary' : 'Show summary'}
              aria-expanded={expanded}
            >
              {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
            </button>
          )}
          {/* Usage-only rows have no sessions record: nothing to attach, stop, or delete. */}
          {!session.usageOnly && (
            <>
              <SessionActionButtons
                session={session}
                onMarkStopped={onMarkStopped}
                onTogglePin={onTogglePin}
                onToggleArchive={onToggleArchive}
                onRename={onRename}
              />
              <button
                onClick={onDelete}
                className="text-muted-foreground hover:text-destructive"
                title="Delete session"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </>
          )}
          {session.usageOnly && !canExpand && <span className="text-muted-foreground">&mdash;</span>}
        </div>
      </td>
    </tr>
    {expanded && canExpand && (
      <tr className="border-b border-border/20 bg-muted/20">
        <td colSpan={SESSION_TABLE_COLUMN_COUNT} className="px-8 py-3">
          <div className="flex flex-col gap-3 text-xs">
            {session.summary && (
              <div>
                <div className="mb-1 font-medium uppercase tracking-wide text-muted-foreground">Summary</div>
                <p className="max-w-3xl text-foreground/90">{session.summary}</p>
              </div>
            )}
            {session.usage?.models.length ? (
              <div>
                <div className="mb-1 font-medium uppercase tracking-wide text-muted-foreground">
                  Spend by model
                </div>
                <table className="text-xs">
                  <tbody>
                    {session.usage.models.map((m) => (
                      <tr key={m.model}>
                        <td className="pr-4 font-mono text-muted-foreground">{m.model}</td>
                        <td className="pr-4 text-right tabular-nums">{formatCost(m.cost)}</td>
                        <td className="text-right tabular-nums text-muted-foreground">
                          {formatTokens(m.tokens)} tokens
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
          </div>
        </td>
      </tr>
    )}
    </>
  );
}



