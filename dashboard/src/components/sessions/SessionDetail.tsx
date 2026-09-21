import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { X } from 'lucide-react';
import { useAgentSession } from '../../hooks/useProjects';
import { LoadingState } from '../LoadingState';
import { ErrorState } from '../ErrorState';
import { SectionCard } from '../SectionCard';
import { EmptyState } from '../EmptyState';
import { CopyButton } from '../CopyButton';
import { formatDateTime, formatCost, formatTokens } from '../../lib/format';
import { cn } from '../../lib/utils';

export interface SessionDetailProps {
  sessionId: string;
  onClose: () => void;
  /** Full-page layout (legacy `/agent-sessions/:id`). */
  variant?: 'drawer' | 'page';
}

export function SessionDetail({ sessionId, onClose, variant = 'drawer' }: SessionDetailProps) {
  const { data, loading, error, refetch } = useAgentSession(sessionId);
  const session = data?.session;

  useEffect(() => {
    if (variant !== 'drawer') return;
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, variant]);

  const body = (
    <div className={cn('space-y-4', variant === 'page' ? 'mx-auto max-w-5xl p-4' : 'p-4')}>
      {loading && !session ? <LoadingState label="Loading session…" /> : null}
      {error ? <ErrorState error={error} onRetry={refetch} /> : null}
      {!loading && !error && !session ? <ErrorState error="Session not found." /> : null}
      {session ? (
        <>
          <SectionCard title={session.sessionId} description={session.path || undefined}>
            <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
              <Row label="Agent" value={session.agent} />
              <Row label="Status" value={session.isLive ? `${session.status} · live` : session.status} />
              <Row label="Started" value={formatDateTime(session.started)} />
              <Row label="Ended" value={session.ended ? formatDateTime(session.ended) : '—'} />
              {session.description ? <Row label="Name" value={session.description} /> : null}
              {session.transcriptPath ? (
                <div className="flex min-w-0 items-center gap-1.5">
                  <dt className="shrink-0 text-muted-foreground">Transcript</dt>
                  <dd className="min-w-0 truncate font-mono text-xs" title={session.transcriptPath}>
                    {session.transcriptPath}
                  </dd>
                  <CopyButton value={session.transcriptPath} />
                </div>
              ) : null}
            </dl>
            {session.summary ? (
              <p className="mt-3 whitespace-pre-wrap text-sm text-muted-foreground">{session.summary}</p>
            ) : null}
          </SectionCard>

          <SectionCard title="Usage" description="Spend attributed to this session id.">
            {session.usage ? (
              <div className="space-y-2 text-sm">
                <div className="flex flex-wrap gap-x-4 gap-y-1">
                  <span>{formatCost(session.usage.totalCost)}</span>
                  <span className="text-muted-foreground">{formatTokens(session.usage.totalTokens)} tokens total</span>
                  {typeof session.usage.totalInputTokens === 'number'
                  && typeof session.usage.totalOutputTokens === 'number' ? (
                    <>
                      <span className="text-muted-foreground">
                        {formatTokens(session.usage.totalInputTokens)} in
                      </span>
                      <span className="text-muted-foreground">
                        {formatTokens(session.usage.totalOutputTokens)} out
                      </span>
                      {typeof session.usage.totalCacheTokens === 'number' ? (
                        <span className="text-muted-foreground">
                          {formatTokens(session.usage.totalCacheTokens)} cache
                        </span>
                      ) : null}
                    </>
                  ) : null}
                </div>
                <ul className="space-y-1 text-xs text-muted-foreground">
                  {session.usage.models.map((m) => (
                    <li key={m.model}>
                      {m.model} — {formatCost(m.cost)} · {formatTokens(m.tokens)} tokens
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <EmptyState title="No usage recorded" description="Nothing has been attributed to this session id." />
            )}
          </SectionCard>

          <SectionCard title="Ticket">
            {session.ticketId ? (
              <p className="text-sm">
                <Link className="underline underline-offset-2" to={`/t/${encodeURIComponent(session.ticketId)}?tab=chat`}>
                  {session.projectSlug}/{session.ticketSlug}
                </Link>{' '}
                <span className="text-muted-foreground">— open its Chat tab to work with an agent.</span>
              </p>
            ) : (
              <EmptyState
                title="Not bound to a ticket"
                description="This session has no engagement linking it to a ticket."
              />
            )}
          </SectionCard>
        </>
      ) : null}
    </div>
  );

  if (variant === 'page') return body;

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <button
        type="button"
        className="absolute inset-0 bg-background/60 backdrop-blur-sm"
        aria-label="Close session detail"
        onClick={onClose}
      />
      <aside
        role="dialog"
        aria-modal="true"
        aria-label="Session detail"
        className="relative z-10 flex h-full w-full max-w-xl flex-col border-l border-border/60 bg-background shadow-xl"
      >
        <div className="flex items-center justify-between border-b border-border/40 px-4 py-3">
          <h2 className="text-sm font-semibold">Session detail</h2>
          <button type="button" className="shell-action mt-0 p-1" onClick={onClose} aria-label="Close">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">{body}</div>
      </aside>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-w-0 gap-2">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 truncate">{value}</dd>
    </div>
  );
}
