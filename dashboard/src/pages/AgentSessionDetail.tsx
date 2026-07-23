// Agent session detail page (Phase D). Hosts the browser terminal: mints a
// single-use pty token for an attachable (live, daemon-hosted) session and
// renders SessionTerminal; shows the settled final screen for a terminal
// session, a retryable banner when the daemon is unavailable, or a "not
// attachable" state otherwise. Handles the pre-upgrade race (a mint 409/404
// means the session just exited → refetch and re-render from fresh detail).

import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useAgentSession } from '../hooks/useProjects';
import { LoadingState } from '../components/LoadingState';
import { ErrorState } from '../components/ErrorState';
import { SectionCard } from '../components/SectionCard';
import { EmptyState } from '../components/EmptyState';
import { SessionTerminal } from '../components/SessionTerminal';
import type { CloseReason } from '../lib/terminalSocket';

export function AgentSessionDetail(): JSX.Element {
  const { id } = useParams<{ id: string }>();
  const { data, loading, error, refetch } = useAgentSession(id);
  const session = data?.session;

  const [attach, setAttach] = useState<{ token: string; short: string } | null>(null);
  const [viewOnly, setViewOnly] = useState(true);
  const [mintError, setMintError] = useState<string | null>(null);

  // Mint a token whenever the session is attachable and we don't already hold one.
  useEffect(() => {
    if (!id || !session?.attachable) {
      setAttach(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/agent-sessions/by-id/${id}/pty-token`, { method: 'POST' });
        if (cancelled) return;
        if (res.status === 409 || res.status === 404) {
          // Pre-upgrade race: the session exited between the detail GET and the
          // mint. Refetch → re-render from fresh detail (settled / unavailable).
          refetch();
          return;
        }
        if (!res.ok) {
          setMintError('Could not prepare the terminal.');
          return;
        }
        const body = (await res.json()) as { token: string; short: string };
        setAttach({ token: body.token, short: body.short });
        setMintError(null);
      } catch {
        if (!cancelled) setMintError('Could not prepare the terminal.');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id, session?.attachable, refetch]);

  const handleClose = useCallback(
    (_reason: CloseReason) => {
      setAttach(null); // token is spent — never reconnect with it
      refetch(); // pull fresh detail → settled screen or a retryable state
    },
    [refetch],
  );

  if (loading && !session) return <LoadingState label="Loading session…" />;
  if (error) return <ErrorState error={error} onRetry={refetch} />;
  if (!session) return <ErrorState error="Session not found." />;

  const controlToggle =
    session.attachable && attach ? (
      <button
        type="button"
        className="rounded border border-border px-2 py-1 text-xs hover:bg-accent"
        onClick={() => setViewOnly((v) => !v)}
      >
        {viewOnly ? 'Take control' : 'Release control'}
      </button>
    ) : undefined;

  return (
    <div className="mx-auto max-w-5xl space-y-4 p-4">
      <SectionCard title={session.sessionId} description={session.path || undefined}>
        <div className="flex flex-wrap gap-x-3 gap-y-1 text-sm text-muted-foreground">
          <span>{session.agent}</span>
          {session.syntaurdState ? <span>· {session.syntaurdState}</span> : null}
          {session.needs ? <span className="text-yellow-500">· ⚠ {session.needs}</span> : null}
        </div>
      </SectionCard>

      <SectionCard title="Terminal" actions={controlToggle}>
        <div className="h-[480px] w-full overflow-hidden rounded-md border border-border bg-black">
          {session.attachable && attach ? (
            <SessionTerminal short={attach.short} token={attach.token} viewOnly={viewOnly} onClose={handleClose} />
          ) : session.attachable && !attach && !mintError ? (
            <LoadingState label="Connecting…" />
          ) : mintError ? (
            <ErrorState error={mintError} onRetry={refetch} />
          ) : session.settled ? (
            <SessionTerminal settledScreen={session.settled.lastScreen} viewOnly />
          ) : session.daemonUnavailable ? (
            <EmptyState
              title="Session unavailable"
              description="The syntaur daemon is not reachable right now. Retry shortly."
              actions={
                <button
                  type="button"
                  className="rounded border border-border px-3 py-1 text-sm hover:bg-accent"
                  onClick={() => refetch()}
                >
                  Retry
                </button>
              }
            />
          ) : (
            <EmptyState
              title="Not attachable"
              description="This session is not hosted by the syntaur daemon, so it has no live terminal."
            />
          )}
        </div>
        {session.settled ? (
          <p className="mt-2 text-xs text-muted-foreground">
            Session exited{session.settled.exitCode != null ? ` (code ${session.settled.exitCode})` : ''} —
            showing its final screen.
          </p>
        ) : null}
      </SectionCard>
    </div>
  );
}
