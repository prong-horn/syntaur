import { useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import {
  ArrowUpRight,
  BookOpenText,
  ExternalLink,
  FilePenLine,
  Hammer,
  NotebookPen,
  SendToBack,
} from 'lucide-react';
import { useAssignment, useServers, type AssignmentTransitionAction } from '../hooks/useMissions';
import { formatDateTime } from '../lib/format';
import { PageHeader } from '../components/PageHeader';
import { LoadingState } from '../components/LoadingState';
import { ErrorState } from '../components/ErrorState';
import { StatusBadge } from '../components/StatusBadge';
import { ContentTabs } from '../components/ContentTabs';
import { SectionCard } from '../components/SectionCard';
import { MarkdownRenderer } from '../components/MarkdownRenderer';
import { EmptyState } from '../components/EmptyState';
import { runAssignmentTransition, overrideAssignmentStatus } from '../lib/assignments';

export function AssignmentDetail() {
  const { slug, aslug } = useParams<{ slug: string; aslug: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const [transitionError, setTransitionError] = useState<string | null>(null);
  const [transitioning, setTransitioning] = useState<string | null>(null);
  const tab = searchParams.get('tab') ?? 'summary';
  const { data: assignment, loading, error, refetch } = useAssignment(slug, aslug);
  const { data: serversData } = useServers();

  if (loading) {
    return <LoadingState label="Loading assignment workspace…" />;
  }

  if (error || !assignment || !slug || !aslug) {
    return <ErrorState error={error || 'Assignment not found.'} />;
  }

  const missionSlug = slug;
  const assignmentSlug = aslug;

  const linkedPanes: Array<{ sessionName: string; command: string; urls: string[] }> = [];
  if (serversData?.sessions) {
    for (const session of serversData.sessions) {
      for (const win of session.windows) {
        for (const pane of win.panes) {
          if (pane.assignment?.mission === slug && pane.assignment?.slug === aslug) {
            linkedPanes.push({
              sessionName: session.name,
              command: pane.command,
              urls: pane.urls,
            });
          }
        }
      }
    }
  }

  async function handleStatusOverride(status: string) {
    setTransitionError(null);
    try {
      await overrideAssignmentStatus(missionSlug, assignmentSlug, status);
      refetch();
    } catch (err) {
      setTransitionError((err as Error).message);
    }
  }

  async function runTransition(action: AssignmentTransitionAction) {
    setTransitionError(null);
    setTransitioning(action.command);

    try {
      let reason: string | undefined;
      if (action.command === 'block') {
        reason = window.prompt('Reason for blocking (optional)')?.trim() || undefined;
      }

      await runAssignmentTransition(missionSlug, assignmentSlug, action, reason);
      refetch();
    } catch (mutationError) {
      setTransitionError((mutationError as Error).message);
    } finally {
      setTransitioning(null);
    }
  }

  return (
    <div className="space-y-5">
      <div className="sticky top-12 z-20 rounded-lg border border-border/60 bg-card/90 p-3 shadow-sm backdrop-blur">
        <PageHeader
          eyebrow="Execution Console"
          title={assignment.title}
          description={`Mission ${slug} · Updated ${formatDateTime(assignment.updated)}`}
          actions={
            <>
              <StatusBadge status={assignment.status} />
              <Link className="shell-action" to={`/missions/${slug}`}>
                Mission
              </Link>
              <Link className="shell-action" to={`/missions/${slug}/assignments/${aslug}/edit`}>
                <FilePenLine className="h-4 w-4" />
                <span>Edit Assignment</span>
              </Link>
            </>
          }
        />

        <div className="mt-5 flex flex-wrap gap-2">
          {(assignment.availableTransitions ?? []).map((action) => (
            <button
              key={action.command}
              type="button"
              title={action.warning || action.disabledReason || action.description}
              disabled={action.disabled || transitioning === action.command}
              onClick={() => runTransition(action)}
              className={`shell-action disabled:cursor-not-allowed disabled:opacity-50 ${action.warning ? 'border-amber-300 dark:border-amber-700' : ''}`}
            >
              <span>{transitioning === action.command ? 'Working…' : action.label}</span>
            </button>
          ))}
          <select
            className="shell-action appearance-none bg-transparent text-sm text-muted-foreground"
            value=""
            onChange={(e) => {
              if (e.target.value) handleStatusOverride(e.target.value);
            }}
            title="Override assignment status directly"
          >
            <option value="">Override Status…</option>
            <option value="pending">Pending</option>
            <option value="in_progress">In Progress</option>
            <option value="blocked">Blocked</option>
            <option value="review">Review</option>
            <option value="completed">Completed</option>
            <option value="failed">Failed</option>
          </select>
        </div>

        {transitionError ? (
          <p className="mt-4 rounded-md border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700 dark:border-rose-900 dark:bg-rose-950/30 dark:text-rose-300">
            {transitionError}
          </p>
        ) : null}

        {assignment.blockedReason ? (
          <div className="mt-4 rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-300">
            <strong>Blocked reason:</strong> {assignment.blockedReason}
          </div>
        ) : null}

        <div className="mt-5 flex flex-wrap gap-2">
          <Chip label={`Priority ${assignment.priority}`} />
          <Chip label={assignment.assignee ? `Assignee ${assignment.assignee}` : 'Unassigned'} />
          <Chip label={`${assignment.dependsOn.length} dependencies`} />
          <Chip label={assignment.plan ? `Plan ${assignment.plan.status}` : 'No plan'} />
          <Chip label={`${assignment.handoff?.handoffCount ?? 0} handoffs`} />
          <Chip label={`${assignment.decisionRecord?.decisionCount ?? 0} decisions`} />
          <Chip label={isStale(assignment.updated) ? 'Stale' : 'Fresh'} />
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_280px]">
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
                    <SectionCard title="Assignment Summary">
                      <MarkdownRenderer
                        content={assignment.body}
                        emptyState="This assignment does not have summary markdown yet."
                      />
                    </SectionCard>

                    <SectionCard title="Latest Log Context">
                      <div className="grid gap-3 lg:grid-cols-2">
                        <div className="rounded-md border border-border/60 bg-background/80 p-3">
                          <h3 className="font-semibold text-foreground">Latest handoff</h3>
                          <p className="mt-2 text-sm leading-6 text-muted-foreground">
                            {assignment.handoff ? extractLead(assignment.handoff.body) : 'No handoff entries yet.'}
                          </p>
                        </div>
                        <div className="rounded-md border border-border/60 bg-background/80 p-3">
                          <h3 className="font-semibold text-foreground">Latest decision</h3>
                          <p className="mt-2 text-sm leading-6 text-muted-foreground">
                            {assignment.decisionRecord ? extractLead(assignment.decisionRecord.body) : 'No decision entries yet.'}
                          </p>
                        </div>
                      </div>
                    </SectionCard>
                  </div>
                ),
              },
              {
                value: 'plan',
                label: 'Plan',
                count: assignment.plan ? 1 : 0,
                content: assignment.plan ? (
                  <div className="space-y-5">
                    <SectionCard
                      title="Plan"
                      actions={
                        <Link className="shell-action" to={`/missions/${slug}/assignments/${aslug}/plan/edit`}>
                          <NotebookPen className="h-4 w-4" />
                          <span>Edit Plan</span>
                        </Link>
                      }
                    >
                      <div className="mb-4">
                        <StatusBadge status={assignment.plan.status} />
                      </div>
                      <MarkdownRenderer content={assignment.plan.body} emptyState="No plan content yet." />
                    </SectionCard>
                  </div>
                ) : (
                  <EmptyState
                    title="No plan yet"
                    description="This assignment does not have a plan document yet."
                  />
                ),
              },
              {
                value: 'scratchpad',
                label: 'Scratchpad',
                count: assignment.scratchpad ? 1 : 0,
                content: assignment.scratchpad ? (
                  <SectionCard
                    title="Scratchpad"
                    actions={
                      <Link className="shell-action" to={`/missions/${slug}/assignments/${aslug}/scratchpad/edit`}>
                        <NotebookPen className="h-4 w-4" />
                        <span>Edit Scratchpad</span>
                      </Link>
                    }
                  >
                    <MarkdownRenderer content={assignment.scratchpad.body} emptyState="Scratchpad is empty." />
                  </SectionCard>
                ) : (
                  <EmptyState
                    title="No scratchpad yet"
                    description="Scratchpad notes appear here when the assignment has working notes."
                  />
                ),
              },
              {
                value: 'handoff',
                label: 'Handoff',
                count: assignment.handoff?.handoffCount ?? 0,
                content: (
                  <div className="space-y-5">
                    {assignment.handoff ? (
                      <SectionCard>
                        <MarkdownRenderer content={assignment.handoff.body} emptyState="No handoff history yet." />
                      </SectionCard>
                    ) : (
                      <EmptyState
                        title="No handoff log yet"
                        description="Add a handoff entry when work changes hands or needs a restart point."
                      />
                    )}
                  </div>
                ),
              },
              {
                value: 'decisions',
                label: 'Decisions',
                count: assignment.decisionRecord?.decisionCount ?? 0,
                content: (
                  <div className="space-y-5">
                    {assignment.decisionRecord ? (
                      <SectionCard>
                        <MarkdownRenderer content={assignment.decisionRecord.body} emptyState="No decision history yet." />
                      </SectionCard>
                    ) : (
                      <EmptyState
                        title="No decision record yet"
                        description="Add a decision entry when the assignment makes a notable implementation choice."
                      />
                    )}
                  </div>
                ),
              },
            ]}
          />
        </div>

        <div className="space-y-5">
          <SectionCard title="Metadata">
            <dl className="space-y-3 text-sm">
              <DetailRow label="Priority" value={assignment.priority} />
              <DetailRow label="Assignee" value={assignment.assignee ?? 'Unassigned'} />
              <DetailRow label="Created" value={formatDateTime(assignment.created)} />
              <DetailRow label="Updated" value={formatDateTime(assignment.updated)} />
              <DetailRow label="Status" value={assignment.status} />
            </dl>
          </SectionCard>

          <SectionCard title="Dependencies">
            {assignment.dependsOn.length === 0 ? (
              <p className="text-sm text-muted-foreground">No declared dependencies.</p>
            ) : (
              <div className="space-y-2">
                {assignment.dependsOn.map((dependency) => (
                  <span key={dependency} className="inline-flex rounded-full border border-border/60 px-2.5 py-1 text-xs text-foreground">
                    {dependency}
                  </span>
                ))}
              </div>
            )}
          </SectionCard>

          <SectionCard title="Workspace Info">
            <dl className="space-y-3 text-sm">
              <DetailRow label="Repository" value={assignment.workspace.repository ?? '\u2014'} />
              <DetailRow label="Worktree" value={assignment.workspace.worktreePath ?? '\u2014'} />
              <DetailRow label="Branch" value={assignment.workspace.branch ?? '\u2014'} />
              <DetailRow label="Parent branch" value={assignment.workspace.parentBranch ?? '\u2014'} />
            </dl>
          </SectionCard>

          {linkedPanes.length > 0 && (
            <SectionCard title="Servers">
              <div className="space-y-2">
                {linkedPanes.map((lp, i) => (
                  <div key={i} className="flex items-center gap-2 text-sm">
                    <span className="rounded bg-muted/60 px-1.5 py-0.5 font-mono text-xs">{lp.command}</span>
                    <span className="text-xs text-muted-foreground">{lp.sessionName}</span>
                    {lp.urls.map(url => (
                      <a key={url} href={url} target="_blank" rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-xs text-teal-600 hover:underline dark:text-teal-400">
                        {url.replace('http://localhost:', ':')}
                        <ExternalLink className="h-2.5 w-2.5" />
                      </a>
                    ))}
                  </div>
                ))}
              </div>
            </SectionCard>
          )}

          <SectionCard title="Edit Actions">
            <div className="space-y-2 text-sm">
              <Link className="flex items-center gap-2 text-primary hover:underline" to={`/missions/${slug}/assignments/${aslug}/edit`}>
                <FilePenLine className="h-4 w-4" />
                Edit assignment source
              </Link>
              <Link className="flex items-center gap-2 text-primary hover:underline" to={`/missions/${slug}/assignments/${aslug}/plan/edit`}>
                <SendToBack className="h-4 w-4" />
                Edit plan
              </Link>
              <Link className="flex items-center gap-2 text-primary hover:underline" to={`/missions/${slug}/assignments/${aslug}/scratchpad/edit`}>
                <NotebookPen className="h-4 w-4" />
                Edit scratchpad
              </Link>
              <Link className="flex items-center gap-2 text-primary hover:underline" to={`/missions/${slug}/assignments/${aslug}/handoff/edit`}>
                <ArrowUpRight className="h-4 w-4" />
                Append handoff
              </Link>
              <Link className="flex items-center gap-2 text-primary hover:underline" to={`/missions/${slug}/assignments/${aslug}/decision-record/edit`}>
                <Hammer className="h-4 w-4" />
                Append decision
              </Link>
            </div>
          </SectionCard>

          <SectionCard title="Status Guidance">
            <div className="space-y-3 text-sm leading-6 text-muted-foreground">
              <p><strong className="text-foreground">Pending</strong> means the work has not started or is structurally waiting on dependencies.</p>
              <p><strong className="text-foreground">Blocked</strong> means there is an active obstacle that needs intervention, which is why blocking requires a reason.</p>
              <p><strong className="text-foreground">Review</strong> means implementation is ready to inspect before completion.</p>
              <Link className="inline-flex items-center gap-2 text-primary hover:underline" to="/help">
                <BookOpenText className="h-4 w-4" />
                Open the full status guide
              </Link>
            </div>
          </SectionCard>
        </div>
      </div>
    </div>
  );
}

function Chip({ label }: { label: string }) {
  return (
    <span className="rounded-full border border-border/60 bg-background/80 px-3 py-1 text-xs font-medium text-muted-foreground">
      {label}
    </span>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="max-w-[60%] text-right text-foreground">{value}</dd>
    </div>
  );
}

function extractLead(content: string): string {
  const normalized = content.replace(/^#+\s+/gm, '').trim();
  return normalized.split('\n').find((line) => line.trim()) ?? 'No detail recorded yet.';
}

function isStale(updated: string): boolean {
  const timestamp = Date.parse(updated);
  if (Number.isNaN(timestamp)) {
    return false;
  }
  return Date.now() - timestamp > 7 * 24 * 60 * 60 * 1000;
}
