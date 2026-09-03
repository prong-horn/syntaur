// Agent session detail page.
//
// It used to be the browser terminal: it minted a single-use pty token for a
// live daemon-hosted session and rendered `SessionTerminal` over the
// `/ws/agent-sessions/<short>/pty` bridge. The daemon and that bridge went in
// phase 4 (Decision 5), so the page is what the plan said would be left of it —
// the session's own facts, its rolled-up spend, and a link to the assignment it
// worked, whose Chat tab is where an agent is now driven.

import { Link, useParams } from 'react-router-dom';
import { useAgentSession } from '../hooks/useProjects';
import { LoadingState } from '../components/LoadingState';
import { ErrorState } from '../components/ErrorState';
import { SectionCard } from '../components/SectionCard';
import { EmptyState } from '../components/EmptyState';
import { CopyButton } from '../components/CopyButton';
import { formatDateTime, formatCost, formatTokens } from '../lib/format';

export function AgentSessionDetail(): JSX.Element {
  const { id } = useParams<{ id: string }>();
  const { data, loading, error, refetch } = useAgentSession(id);
  const session = data?.session;

  if (loading && !session) return <LoadingState label="Loading session…" />;
  if (error) return <ErrorState error={error} onRetry={refetch} />;
  if (!session) return <ErrorState error="Session not found." />;

  const assignmentHref =
    session.projectSlug && session.assignmentSlug
      ? `/projects/${encodeURIComponent(session.projectSlug)}/assignments/${encodeURIComponent(session.assignmentSlug)}?tab=chat`
      : null;

  return (
    <div className="mx-auto max-w-5xl space-y-4 p-4">
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
            <div className="flex gap-4">
              <span>{formatCost(session.usage.totalCost)}</span>
              <span className="text-muted-foreground">{formatTokens(session.usage.totalTokens)} tokens</span>
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

      <SectionCard title="Assignment">
        {assignmentHref ? (
          <p className="text-sm">
            <Link className="underline underline-offset-2" to={assignmentHref}>
              {session.projectSlug}/{session.assignmentSlug}
            </Link>{' '}
            <span className="text-muted-foreground">— open its Chat tab to work with an agent.</span>
          </p>
        ) : (
          <EmptyState
            title="Not bound to an assignment"
            description="This session has no engagement linking it to an assignment."
          />
        )}
      </SectionCard>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="flex min-w-0 gap-2">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 truncate">{value}</dd>
    </div>
  );
}
