import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useAgentSessions } from '../hooks/useProjects';
import { LoadingState } from '../components/LoadingState';
import { ErrorState } from '../components/ErrorState';
import { SessionFilters } from '../components/sessions/SessionFilters';
import { SessionList } from '../components/sessions/SessionList';
import { SessionDetail } from '../components/sessions/SessionDetail';
import { UsagePanel } from '../components/sessions/UsagePanel';
import {
  deleteAgentSessions,
  markSessionStopped,
  patchSessionCuration,
  sessionsList,
} from '../data/sessionResources';
import { errorMessage, isApiError } from '../data/client';
import {
  parseSessionUrlState,
  patchSessionUrlState,
  sessionUrlToQuery,
  serializeSessionUrlState,
} from '../lib/sessionUrlState';
import { parseUsageUrlState, serializeUsageUrlState, type UsageUrlState } from '../lib/usageUrlState';
function useDebounced<T>(value: T, delay: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = globalThis.setTimeout(() => setSettled(value), delay);
    return () => globalThis.clearTimeout(timer);
  }, [value, delay]);
  return settled;
}

export function SessionsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const sessionState = useMemo(() => parseSessionUrlState(searchParams), [searchParams]);
  const usageState = useMemo(() => parseUsageUrlState(searchParams), [searchParams]);

  const debouncedSearch = useDebounced(sessionState.search, 250);
  const query = useMemo(
    () => sessionUrlToQuery(sessionState, debouncedSearch),
    [sessionState, debouncedSearch],
  );

  const { data, loading, error } = useAgentSessions(query);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  // Seed default usage window once so back/forward has a baseline.
  useEffect(() => {
    if (!searchParams.get('usageWindow') && sessionState.panel === 'usage') {
      const next = serializeUsageUrlState(usageState, searchParams);
      setSearchParams(next, { replace: true });
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const pushSession = useCallback(
    (patch: Parameters<typeof patchSessionUrlState>[1]) => {
      setSearchParams(patchSessionUrlState(sessionState, patch, searchParams));
    },
    [searchParams, sessionState, setSearchParams],
  );

  const pushUsage = useCallback(
    (next: UsageUrlState) => {
      const merged = serializeUsageUrlState(next, serializeSessionUrlState(sessionState, searchParams));
      setSearchParams(merged);
    },
    [searchParams, sessionState, setSearchParams],
  );

  async function handleDelete(ids: string[]) {
    setDeleteError(null);
    setDeleting(true);
    try {
      await deleteAgentSessions(ids);
    } catch (err) {
      setDeleteError(isApiError(err) ? errorMessage(err) : (err as Error).message);
    } finally {
      setDeleting(false);
    }
  }

  async function handleMarkStopped(sessionId: string) {
    try {
      await markSessionStopped(sessionId);
    } catch (err) {
      setDeleteError(isApiError(err) ? errorMessage(err) : (err as Error).message);
    }
  }

  async function handleCuration(
    sessionId: string,
    body: { pinned?: boolean; archived?: boolean; name?: string | null },
  ) {
    try {
      await patchSessionCuration(sessionId, body);
    } catch (err) {
      setDeleteError(isApiError(err) ? errorMessage(err) : (err as Error).message);
    }
  }

  function handleRename(sessionId: string) {
    const current = data?.sessions.find((x) => x.sessionId === sessionId)?.description ?? '';
    const next = globalThis.prompt?.('Name this session (leave blank to clear):', current);
    if (next === null) return;
    if (next.trim() === current.trim()) return;
    void handleCuration(sessionId, { name: next });
  }

  const pageSessions = data?.sessions ?? [];
  const totalCount = data?.page?.totalCount ?? pageSessions.length;
  const showUsage = sessionState.panel === 'usage';

  return (
    <div className="p-4 md:p-6">
      <header className="mb-4">
        <h1 className="text-2xl font-semibold text-foreground">Sessions</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Agent sessions, curation, and usage rollup.{' '}
          <button
            type="button"
            className="text-primary underline underline-offset-2"
            onClick={() =>
              pushSession({ panel: showUsage ? undefined : 'usage' })
            }
          >
            {showUsage ? 'Hide usage' : 'Show usage'}
          </button>
        </p>
      </header>

      <SessionFilters
        search={sessionState.search}
        startedFrom={sessionState.startedFrom}
        startedTo={sessionState.startedTo}
        sort={sessionState.sort}
        attribution={sessionState.attribution}
        archived={sessionState.archived}
        pageMeta={data?.page}
        onSearchChange={(value) => pushSession({ search: value })}
        onStartedFromChange={(value) => pushSession({ startedFrom: value })}
        onStartedToChange={(value) => pushSession({ startedTo: value })}
        onSortChange={(value) => pushSession({ sort: value })}
        onAttributionChange={(value) => pushSession({ attribution: value })}
        onArchivedChange={(value) => pushSession({ archived: value })}
      />

      {loading && !data ? <LoadingState label="Loading agent sessions..." /> : null}
      {error ? <ErrorState error={error} /> : null}
      {data ? (
        <SessionList
          sessions={pageSessions}
          pageMeta={data.page}
          page={sessionState.page}
          pageSize={sessionState.pageSize}
          totalCount={totalCount}
          deleting={deleting}
          deleteError={deleteError}
          onPageChange={(page) => pushSession({ page })}
          onPageSizeChange={(pageSize) => pushSession({ pageSize })}
          onDelete={handleDelete}
          onMarkStopped={handleMarkStopped}
          onTogglePin={(id, pinned) => void handleCuration(id, { pinned })}
          onToggleArchive={(id, archivedNext) => void handleCuration(id, { archived: archivedNext })}
          onRename={handleRename}
          onOpenDetail={(sessionId) => pushSession({ sessionId })}
        />
      ) : null}

      {showUsage ? <UsagePanel state={usageState} onChange={pushUsage} /> : null}

      {sessionState.sessionId ? (
        <SessionDetail
          sessionId={sessionState.sessionId}
          onClose={() => pushSession({ sessionId: undefined })}
        />
      ) : null}
    </div>
  );
}

/** SSR/test helper: sessions list resource for a URL state snapshot. */
export function sessionsResourceForUrl(sp: URLSearchParams) {
  const state = parseSessionUrlState(sp);
  return sessionsList(sessionUrlToQuery(state, state.search));
}
