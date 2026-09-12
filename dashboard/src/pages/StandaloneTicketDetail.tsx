import { useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { Archive, ArchiveRestore, ExternalLink } from 'lucide-react';
import { useTicketById, useTicketSessionsById, useStandaloneTicketUsage, type ExternalIdInfo } from '../hooks/useProjects';
import { useTicketEvents } from '../hooks/useTicketEvents';
import { LoadingState } from '../components/LoadingState';
import { ErrorState } from '../components/ErrorState';
import { TicketStatusPill } from '../components/TicketStatusPill';
import { TypeChip } from '../components/TypeChip';
import { ExternalIdBadges } from '../components/ExternalIdBadges';
import { CopyButton } from '../components/CopyButton';
import { formatShortDate, formatShortDateTime } from '../lib/format';
import { ContentTabs } from '../components/ContentTabs';
import { SectionCard } from '../components/SectionCard';
import { MarkdownRenderer } from '../components/MarkdownRenderer';
import { EmptyState } from '../components/EmptyState';
import { CommentsThread } from '../components/CommentsThread';
import { ActivityTimeline } from '../components/ActivityTimeline';
import { AgentSessionsSection } from '../components/AgentSessionsSection';
import { TicketUsageSection } from '../components/TicketUsageSection';
import { ChatTab } from '../components/chat/ChatTab';
import { CreateWorktreeButton } from '../components/CreateWorktreeButton';
import { useToast, Toaster } from '../components/Toast';
import { useHashScroll } from '../hooks/useHashScroll';

/**
 * Read-and-edit view for standalone tickets (those at
 * `~/.syntaur/tickets/<uuid>/`). Edit links route to the shared editor pages.
 */
export function StandaloneTicketDetail() {
  const { id } = useParams<{ id: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = searchParams.get('tab') ?? 'summary';
  // Standalone hits can carry `#section` too — honor the deep-link hash.
  useHashScroll(tab);
  const { data: ticket, loading, error, refetch } = useTicketById(id);
  const { data: sessionsData, loading: sessionsLoading, error: sessionsError } = useTicketSessionsById(id);
  // D3: the standalone usage endpoint keys on the ticket SLUG, not the UUID
  // `id`. `ticket` is undefined until loaded, so gate on `ticket?.slug`.
  const { data: usageData, loading: usageLoading, error: usageError } = useStandaloneTicketUsage(ticket?.slug);
  // Events are keyed on the standalone UUID `id` (the events table's
  // assignment_id), unlike usage which keys on the slug.
  const eventsUrl = id ? `/api/standalone/tickets/${id}/events` : null;
  const {
    events,
    loading: eventsLoading,
    error: eventsError,
    refetch: refetchEvents,
  } = useTicketEvents(eventsUrl);
  const [archiveError, setArchiveError] = useState<string | null>(null);
  const { toast, showToast, dismissToast } = useToast();

  async function handleArchive(archived: boolean) {
    if (!id) return;
    setArchiveError(null);
    try {
      const res = await fetch(`/api/tickets/${id}/${archived ? 'archive' : 'unarchive'}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => null);
        throw new Error(payload?.error || `HTTP ${res.status}`);
      }
      refetch();
      refetchEvents();
      showToast(archived ? 'Ticket archived' : 'Ticket restored', 'success');
    } catch (err) {
      setArchiveError(err instanceof Error ? err.message : 'Archive failed');
    }
  }

  if (loading) return <LoadingState />;
  if (error) return <ErrorState error={error} />;
  if (!ticket) return <ErrorState error="Ticket not found" />;

  return (
    <div className="space-y-6">
      <Toaster toast={toast} onDismiss={dismissToast} />
      <header className="space-y-2">
        <div className="flex flex-wrap items-center gap-3">
          <TicketStatusPill
            id={ticket.id}
            status={ticket.status}
            title={ticket.title}
            availableTransitions={ticket.availableTransitions}
            onChange={() => refetch()}
          />
          <TypeChip type={ticket.type} />
          <span className="text-xs font-mono text-muted-foreground">{ticket.id}</span>
          <ExternalIdBadges externalIds={ticket.externalIds} />
          <div className="ml-auto flex items-center gap-2">
            {!ticket.workspace?.worktreePath && (
              <CreateWorktreeButton
                ticketId={ticket.id}
                defaultBranch={`syntaur/${ticket.slug}`}
                onCreated={() => refetch()}
              />
            )}
            <Link
              to={`/tickets/${ticket.id}/edit`}
              className="rounded border border-border px-2 py-1 text-xs text-muted-foreground hover:border-foreground/40 hover:text-foreground"
            >
              Edit
            </Link>
            <button
              type="button"
              onClick={() => handleArchive(!ticket.archived)}
              className="inline-flex items-center gap-1.5 rounded border border-border px-2 py-1 text-xs text-muted-foreground hover:border-foreground/40 hover:text-foreground"
              title={ticket.archived ? 'Restore this ticket' : 'Archive this ticket'}
            >
              {ticket.archived ? <ArchiveRestore className="h-3 w-3" /> : <Archive className="h-3 w-3" />}
              {ticket.archived ? 'Restore' : 'Archive'}
            </button>
          </div>
        </div>
        <h1 className="text-2xl font-semibold text-foreground">{ticket.title}</h1>
        {ticket.blockedReason ? (
          <p className="text-sm text-warning-foreground">Blocked: {ticket.blockedReason}</p>
        ) : null}
        {archiveError ? (
          <p className="text-sm text-status-failed-foreground">{archiveError}</p>
        ) : null}
      </header>

      {ticket.referencedBy && ticket.referencedBy.length > 0 ? (
        <SectionCard
          title="Referenced by"
          description="Other tickets whose bodies link to this one."
        >
          <ul className="space-y-2">
            {ticket.referencedBy.map((ref) => (
              <li key={ref.sourceId} className="flex items-center gap-2 text-sm">
                <Link
                  to={
                    ref.sourceProjectSlug === null
                      ? `/tickets/${ref.sourceId}`
                      : `/projects/${ref.sourceProjectSlug}/tickets/${ref.sourceSlug}`
                  }
                  className="text-foreground hover:text-primary"
                >
                  {ref.sourceTitle}
                </Link>
                <span className="text-xs text-muted-foreground">
                  ({ref.mentions} mention{ref.mentions === 1 ? '' : 's'})
                </span>
              </li>
            ))}
          </ul>
        </SectionCard>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_280px]">
        <div className="space-y-4">
          <ContentTabs
            value={tab}
            onValueChange={(value) => setSearchParams({ tab: value })}
            items={[
              {
                value: 'summary',
                label: 'Summary',
                content: (
                  <div className="space-y-5">
                    <SectionCard title="Ticket">
                      <MarkdownRenderer
                        content={ticket.body}
                        emptyState="This ticket does not have summary markdown yet."
                      />
                    </SectionCard>
                  </div>
                ),
              },
              {
                value: 'chat',
                label: 'Chat',
                content: <ChatTab ticketId={ticket.id} />,
              },
              {
                value: 'progress',
                label: 'Progress',
                count: ticket.progress?.entryCount ?? 0,
                content: (
                  <div className="space-y-5">
                    {ticket.progress && ticket.progress.entries.length > 0 ? (
                      <SectionCard
                        title="Progress"
                        description="Reverse-chronological log of work done on this ticket."
                      >
                        <ol className="space-y-4">
                          {ticket.progress.entries.map((entry, idx) => (
                            <li key={`${entry.timestamp}-${idx}`} className="border-l-2 border-border pl-3">
                              <div className="text-xs font-mono text-muted-foreground">{entry.timestamp}</div>
                              <MarkdownRenderer content={entry.body} />
                            </li>
                          ))}
                        </ol>
                      </SectionCard>
                    ) : (
                      <EmptyState
                        title="No progress entries yet"
                        description="Progress entries appear here as the agent appends them to progress.md."
                      />
                    )}
                  </div>
                ),
              },
              {
                value: 'comments',
                label: 'Comments',
                count: ticket.comments?.entryCount ?? 0,
                content: (
                  <div className="space-y-5">
                    <CommentsThread
                      projectSlug={null}
                      ticketSlug={ticket.id}
                      entries={ticket.comments?.entries ?? []}
                    />
                  </div>
                ),
              },
              {
                value: 'plan',
                label: 'Plan',
                content: (
                  <div className="space-y-5">
                    {ticket.plan ? (
                      <SectionCard>
                        <MarkdownRenderer content={ticket.plan.body} emptyState="Plan file exists but is empty." />
                        <div className="mt-3 flex justify-end">
                          <Link
                            to={`/tickets/${ticket.id}/plan/edit`}
                            className="rounded border border-border px-2 py-1 text-xs text-muted-foreground hover:border-foreground/40 hover:text-foreground"
                          >
                            Edit plan
                          </Link>
                        </div>
                      </SectionCard>
                    ) : (
                      <EmptyState
                        title="No plan file yet"
                        description="Create one via the CLI or `/plan-ticket`."
                      />
                    )}
                  </div>
                ),
              },
              {
                value: 'scratchpad',
                label: 'Scratchpad',
                content: (
                  <div className="space-y-5">
                    {ticket.scratchpad ? (
                      <SectionCard>
                        <MarkdownRenderer content={ticket.scratchpad.body} emptyState="Scratchpad is empty." />
                        <div className="mt-3 flex justify-end">
                          <Link
                            to={`/tickets/${ticket.id}/scratchpad/edit`}
                            className="rounded border border-border px-2 py-1 text-xs text-muted-foreground hover:border-foreground/40 hover:text-foreground"
                          >
                            Edit scratchpad
                          </Link>
                        </div>
                      </SectionCard>
                    ) : (
                      <EmptyState
                        title="No scratchpad yet"
                        description="Scratchpad is scaffolded at ticket creation time."
                      />
                    )}
                  </div>
                ),
              },
              {
                value: 'handoff',
                label: 'Handoff',
                count: ticket.handoff?.handoffCount ?? 0,
                content: (
                  <div className="space-y-5">
                    {ticket.handoff ? (
                      <SectionCard>
                        <MarkdownRenderer content={ticket.handoff.body} emptyState="No handoff history yet." />
                        <div className="mt-3 flex justify-end">
                          <Link
                            to={`/tickets/${ticket.id}/handoff/edit`}
                            className="rounded border border-border px-2 py-1 text-xs text-muted-foreground hover:border-foreground/40 hover:text-foreground"
                          >
                            Append handoff
                          </Link>
                        </div>
                      </SectionCard>
                    ) : (
                      <EmptyState
                        title="No handoff log yet"
                        description="Handoffs appear here when an agent appends one."
                      />
                    )}
                  </div>
                ),
              },
              {
                value: 'decisions',
                label: 'Decisions',
                count: ticket.decisionRecord?.decisionCount ?? 0,
                content: (
                  <div className="space-y-5">
                    {ticket.decisionRecord ? (
                      <SectionCard>
                        <MarkdownRenderer content={ticket.decisionRecord.body} emptyState="No decision history yet." />
                        <div className="mt-3 flex justify-end">
                          <Link
                            to={`/tickets/${ticket.id}/decision-record/edit`}
                            className="rounded border border-border px-2 py-1 text-xs text-muted-foreground hover:border-foreground/40 hover:text-foreground"
                          >
                            Append decision
                          </Link>
                        </div>
                      </SectionCard>
                    ) : (
                      <EmptyState
                        title="No decision record yet"
                        description="Decision records appear here once appended."
                      />
                    )}
                  </div>
                ),
              },
              {
                value: 'activity',
                label: 'Activity',
                count: events.length,
                content: (
                  <ActivityTimeline
                    events={events}
                    loading={eventsLoading}
                    error={eventsError}
                  />
                ),
              },
            ]}
          />
        </div>

        <div className="min-w-0 space-y-5">
          <SectionCard title="Details">
            <dl className="space-y-3 text-sm">
              <DetailRow label="ID" value={ticket.id} copyable />
              <DetailRow label="Priority" value={ticket.priority} />
              {ticket.assignee && <DetailRow label="Assignee" value={ticket.assignee} />}
              <DetailRow
                label="Updated"
                value={`${formatShortDateTime(ticket.updated)} · Created ${formatShortDate(ticket.created)}`}
              />
              {ticket.workspace.repository && (
                <DetailRow label="Repository" value={ticket.workspace.repository} copyable />
              )}
              {ticket.workspace.worktreePath && (
                <DetailRow label="Worktree" value={ticket.workspace.worktreePath} copyable />
              )}
              {ticket.workspace.branch && (
                <DetailRow label="Branch" value={ticket.workspace.branch} copyable />
              )}
              {ticket.workspace.parentBranch && (
                <DetailRow label="Parent branch" value={ticket.workspace.parentBranch} copyable />
              )}
              {ticket.externalIds.map((entry, idx) => (
                <ExternalIdRow key={`${entry.system}:${entry.id}:${idx}`} entry={entry} />
              ))}
            </dl>
          </SectionCard>

          <AgentSessionsSection
            sessions={sessionsData?.sessions}
            loading={sessionsLoading}
            error={sessionsError}
            onError={(e) => showToast(e.message, 'error')}
            onNotice={(m) => showToast(m, 'success')}
          />

          <TicketUsageSection
            summary={usageData?.summary}
            loading={usageLoading}
            error={usageError}
          />
        </div>
      </div>

    </div>
  );
}

function DetailRow({ label, value, copyable }: { label: string; value: string; copyable?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="flex items-center gap-1.5 max-w-[60%] text-right text-foreground break-all">
        <span className="truncate" title={value}>{value}</span>
        {copyable && value !== '—' && <CopyButton value={value} />}
      </dd>
    </div>
  );
}

function ExternalIdRow({ entry }: { entry: ExternalIdInfo }) {
  const hasUrl = entry.url != null && entry.url.length > 0;
  return (
    <div className="flex items-start justify-between gap-3">
      <dt className="text-muted-foreground">{entry.system}</dt>
      <dd className="flex items-center gap-1.5 max-w-[60%] text-right text-foreground break-all">
        {hasUrl ? (
          <a
            href={entry.url ?? undefined}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={`Open ${entry.system}:${entry.id} in ${entry.system}`}
            className="flex items-center gap-1.5 min-w-0 text-primary hover:underline"
          >
            <span className="truncate min-w-0" title={entry.id}>{entry.id}</span>
            <ExternalLink className="h-2.5 w-2.5 shrink-0" />
          </a>
        ) : (
          <span className="truncate min-w-0" title={entry.id}>{entry.id}</span>
        )}
      </dd>
    </div>
  );
}

