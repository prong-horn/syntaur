import { Fragment, useEffect, useMemo, useState } from 'react';
import { CheckSquare, Square, Trash2 } from 'lucide-react';
import { headerCheckState, selectableSessionIds } from '@shared/session-select';
import { ConfirmDialog } from '../ConfirmDialog';
import { EmptyState } from '../EmptyState';
import { SESSION_PAGE_SIZE_OPTIONS } from '../../lib/sessionUrlState';
import type { AgentSessionWithLiveness } from '../../types';
import type { AgentSessionsResponse } from '../../data/types';
import { isEffectivelyPinned, SESSION_TABLE_COLUMN_COUNT, SessionRow } from './SessionRow';

export interface PendingDelete {
  sessionIds: string[];
  title: string;
  description: string;
  confirmLabel: string;
}

export interface SessionListProps {
  sessions: AgentSessionWithLiveness[];
  pageMeta?: AgentSessionsResponse['page'];
  page: number;
  pageSize: number;
  totalCount: number;
  deleting: boolean;
  deleteError: string | null;
  onPageChange: (page: number) => void;
  onPageSizeChange: (pageSize: number) => void;
  onDelete: (sessionIds: string[]) => Promise<void>;
  onMarkStopped: (sessionId: string) => void;
  onTogglePin: (sessionId: string, pinned: boolean) => void;
  onToggleArchive: (sessionId: string, archived: boolean) => void;
  onRename: (sessionId: string) => void;
  onOpenDetail?: (sessionId: string) => void;
}

export function SessionList({
  sessions,
  pageMeta,
  page,
  pageSize,
  totalCount,
  deleting,
  deleteError,
  onPageChange,
  onPageSizeChange,
  onDelete,
  onMarkStopped,
  onTogglePin,
  onToggleArchive,
  onRename,
  onOpenDetail,
}: SessionListProps) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

  const pageCount = pageMeta?.pageCount ?? 1;
  const hasAnySessions = totalCount > 0 || sessions.length > 0;

  useEffect(() => {
    if (pageMeta && page > 0 && page > pageMeta.pageCount - 1) {
      onPageChange(pageMeta.pageCount - 1);
    }
  }, [pageMeta, page, onPageChange]);

  const headerState = useMemo(() => headerCheckState(sessions, selectedIds), [sessions, selectedIds]);

  const actionableIds = useMemo(() => {
    const visible = new Set(selectableSessionIds(sessions));
    return [...selectedIds].filter((id) => visible.has(id));
  }, [sessions, selectedIds]);

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
    const eligible = selectableSessionIds(sessions);
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (headerState === 'all') {
        for (const id of eligible) next.delete(id);
      } else {
        for (const id of eligible) next.add(id);
      }
      return next;
    });
  }

  if (!hasAnySessions) {
    return (
      <EmptyState
        title="No agent sessions"
        description="No agent sessions have been registered yet. Use /grab or syntaur track-session to register one."
      />
    );
  }

  if (totalCount === 0) {
    return (
      <EmptyState
        title="No agent sessions match these filters"
        description="Adjust the status, search term, date range, or sorting controls to show sessions again."
      />
    );
  }

  return (
    <>
      {deleteError ? (
        <div className="mt-4 rounded-md border border-error-foreground/30 bg-error px-4 py-3 text-sm text-error-foreground">
          {deleteError}
        </div>
      ) : null}

      {actionableIds.length > 0 ? (
        <div className="mt-4 flex items-center gap-3 rounded border border-border/40 bg-muted/30 px-4 py-2 text-sm">
          <span className="text-muted-foreground">
            {actionableIds.length} session{actionableIds.length !== 1 ? 's' : ''} selected
          </span>
          <button
            type="button"
            className="shell-action text-destructive"
            onClick={() =>
              setPendingDelete({
                sessionIds: actionableIds,
                title: `Delete ${actionableIds.length} selected session${actionableIds.length === 1 ? '' : 's'}?`,
                description:
                  'This removes the selected agent session records from the dashboard. This cannot be undone.',
                confirmLabel: actionableIds.length === 1 ? 'Delete Session' : 'Delete Sessions',
              })
            }
            disabled={deleting}
          >
            <Trash2 className="mr-1 inline h-3.5 w-3.5" />
            Delete Selected
          </button>
          <button type="button" className="shell-action" onClick={() => setSelectedIds(new Set())}>
            Clear Selection
          </button>
        </div>
      ) : null}

      <div className="surface-panel mt-4">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1100px] table-fixed text-sm lg:min-w-[1420px]">
            <thead>
              <tr className="border-b border-border/40 text-left text-xs uppercase tracking-wider text-muted-foreground">
                <th className="w-[32px] pb-2 pr-3">
                  <button
                    type="button"
                    onClick={toggleSelectAll}
                    className="text-muted-foreground hover:text-foreground disabled:opacity-40"
                    disabled={selectableSessionIds(sessions).length === 0}
                    title={headerState === 'all' ? 'Clear selection' : 'Select all'}
                  >
                    {headerState === 'all'
                      ? <CheckSquare className="h-4 w-4" />
                      : <Square className={headerState === 'some' ? 'h-4 w-4 text-primary' : 'h-4 w-4'} />}
                  </button>
                </th>
                <th className="w-[140px] pb-2 pr-3">Project</th>
                <th className="w-[160px] pb-2 pr-3">Ticket</th>
                <th className="w-[200px] pb-2 pr-3">Description</th>
                <th className="w-[110px] pb-2 pr-3">Agent</th>
                <th className="w-[90px] pb-2 pr-3 text-right">Cost</th>
                <th className="w-[100px] pb-2 pr-3 text-right">Tokens</th>
                <th className="w-[110px] pb-2 pr-3 text-right">In / Out</th>
                <th className="hidden w-[130px] pb-2 pr-3 lg:table-cell">Session ID</th>
                <th className="w-[140px] pb-2 pr-3">Started</th>
                <th className="hidden w-[200px] pb-2 pr-3 lg:table-cell">Path</th>
                <th className="hidden w-[200px] pb-2 pr-3 lg:table-cell">Transcript</th>
                <th className="table-sticky-actions w-[104px] pb-2 pl-2" />
              </tr>
            </thead>
            <tbody>
              {sessions.map((session, index) => (
                <Fragment key={session.sessionId}>
                  {index === 0 && isEffectivelyPinned(session) ? (
                    <tr className="bg-accent/30">
                      <td
                        colSpan={SESSION_TABLE_COLUMN_COUNT}
                        className="px-4 py-1 text-xs font-medium uppercase tracking-[0.08em] text-muted-foreground"
                      >
                        Pinned
                      </td>
                    </tr>
                  ) : null}
                  {index > 0 && isEffectivelyPinned(sessions[index - 1]) && !isEffectivelyPinned(session) ? (
                    <tr className="bg-accent/30">
                      <td
                        colSpan={SESSION_TABLE_COLUMN_COUNT}
                        className="px-4 py-1 text-xs font-medium uppercase tracking-[0.08em] text-muted-foreground"
                      >
                        All sessions
                      </td>
                    </tr>
                  ) : null}
                  <SessionRow
                    session={session}
                    selected={selectedIds.has(session.sessionId)}
                    expanded={expandedIds.has(session.sessionId)}
                    onToggle={() => toggleSelection(session.sessionId)}
                    onToggleExpand={() => toggleExpand(session.sessionId)}
                    onDelete={() =>
                      setPendingDelete({
                        sessionIds: [session.sessionId],
                        title: `Delete session ${session.sessionId.slice(0, 8)}...?`,
                        description: `Remove this ${session.agent} session record${session.ticketSlug ? ` for ${session.ticketSlug}` : ''}. This cannot be undone.`,
                        confirmLabel: 'Delete Session',
                      })
                    }
                    onMarkStopped={onMarkStopped}
                    onTogglePin={onTogglePin}
                    onToggleArchive={onToggleArchive}
                    onRename={onRename}
                    onOpenDetail={onOpenDetail}
                  />
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      </div>

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
              onChange={(event) => onPageSizeChange(Number(event.target.value))}
              aria-label="Sessions per page"
              className="rounded-md border border-border/70 bg-background/80 px-2 py-1 text-sm text-foreground"
            >
              {SESSION_PAGE_SIZE_OPTIONS.map((size) => (
                <option key={size} value={size}>
                  {size} / page
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            onClick={() => onPageChange(Math.max(0, page - 1))}
            disabled={page <= 0}
            aria-label="Previous page"
            className="rounded-md border border-border/70 bg-background/80 px-3 py-1 text-sm text-foreground transition hover:bg-accent/40 disabled:opacity-40"
          >
            Previous
          </button>
          <button
            type="button"
            onClick={() => onPageChange(Math.min(pageCount - 1, page + 1))}
            disabled={page >= pageCount - 1}
            aria-label="Next page"
            className="rounded-md border border-border/70 bg-background/80 px-3 py-1 text-sm text-foreground transition hover:bg-accent/40 disabled:opacity-40"
          >
            Next
          </button>
        </div>
      </nav>

      <ConfirmDialog
        open={pendingDelete !== null}
        title={pendingDelete?.title ?? 'Delete session?'}
        description={pendingDelete?.description ?? ''}
        confirmLabel={pendingDelete?.confirmLabel ?? 'Delete'}
        destructive
        loading={deleting}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
        onConfirm={async () => {
          if (!pendingDelete) return;
          const visible = new Set(selectableSessionIds(sessions));
          const stillActionable = pendingDelete.sessionIds.filter((id) => visible.has(id));
          if (stillActionable.length === 0) {
            setPendingDelete(null);
            return;
          }
          await onDelete(stillActionable);
          setSelectedIds((prev) => new Set([...prev].filter((id) => !stillActionable.includes(id))));
          setPendingDelete(null);
        }}
      />
    </>
  );
}
