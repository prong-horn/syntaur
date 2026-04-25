import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useAssignmentById } from '../hooks/useProjects';
import { LoadingState } from '../components/LoadingState';
import { ErrorState } from '../components/ErrorState';
import { StatusBadge } from '../components/StatusBadge';
import { ContentTabs } from '../components/ContentTabs';
import { SectionCard } from '../components/SectionCard';
import { MarkdownRenderer } from '../components/MarkdownRenderer';
import { EmptyState } from '../components/EmptyState';
import { CommentsThread } from '../components/CommentsThread';

/**
 * Read-and-edit view for standalone assignments (those at
 * `~/.syntaur/assignments/<uuid>/`). Edit links route to the shared editor pages.
 */
export function StandaloneAssignmentDetail() {
  const { id } = useParams<{ id: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = searchParams.get('tab') ?? 'summary';
  const { data: assignment, loading, error } = useAssignmentById(id);

  if (loading) return <LoadingState />;
  if (error) return <ErrorState error={error} />;
  if (!assignment) return <ErrorState error="Assignment not found" />;

  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <div className="flex flex-wrap items-center gap-3">
          <StatusBadge status={assignment.status} />
          <span className="text-xs font-mono text-neutral-500">{assignment.id}</span>
          <Link
            to={`/assignments/${assignment.id}/edit`}
            className="ml-auto rounded border border-neutral-700 px-2 py-1 text-xs text-neutral-300 hover:border-neutral-500 hover:text-neutral-100"
          >
            Edit
          </Link>
        </div>
        <h1 className="text-2xl font-semibold text-neutral-100">{assignment.title}</h1>
        {assignment.blockedReason ? (
          <p className="text-sm text-amber-300">Blocked: {assignment.blockedReason}</p>
        ) : null}
      </header>

      {assignment.referencedBy && assignment.referencedBy.length > 0 ? (
        <SectionCard
          title="Referenced by"
          description="Other assignments whose bodies link to this one."
        >
          <ul className="space-y-2">
            {assignment.referencedBy.map((ref) => (
              <li key={ref.sourceId} className="flex items-center gap-2 text-sm">
                <Link
                  to={
                    ref.sourceProjectSlug === null
                      ? `/assignments/${ref.sourceId}`
                      : `/projects/${ref.sourceProjectSlug}/assignments/${ref.sourceSlug}`
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

      <ContentTabs
        value={tab}
        onValueChange={(value) => setSearchParams({ tab: value })}
        items={[
          {
            value: 'summary',
            label: 'Summary',
            content: (
              <div className="space-y-5">
                <SectionCard title="Assignment">
                  <MarkdownRenderer
                    content={assignment.body}
                    emptyState="This assignment does not have summary markdown yet."
                  />
                </SectionCard>
              </div>
            ),
          },
          {
            value: 'progress',
            label: 'Progress',
            count: assignment.progress?.entryCount ?? 0,
            content: (
              <div className="space-y-5">
                {assignment.progress && assignment.progress.entries.length > 0 ? (
                  <SectionCard
                    title="Progress"
                    description="Reverse-chronological log of work done on this assignment."
                  >
                    <ol className="space-y-4">
                      {assignment.progress.entries.map((entry, idx) => (
                        <li key={`${entry.timestamp}-${idx}`} className="border-l-2 border-neutral-700 pl-3">
                          <div className="text-xs font-mono text-neutral-400">{entry.timestamp}</div>
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
            count: assignment.comments?.entryCount ?? 0,
            content: (
              <div className="space-y-5">
                <CommentsThread
                  projectSlug={null}
                  assignmentSlug={assignment.id}
                  entries={assignment.comments?.entries ?? []}
                />
              </div>
            ),
          },
          {
            value: 'plan',
            label: 'Plan',
            content: (
              <div className="space-y-5">
                {assignment.plan ? (
                  <SectionCard>
                    <MarkdownRenderer content={assignment.plan.body} emptyState="Plan file exists but is empty." />
                    <div className="mt-3 flex justify-end">
                      <Link
                        to={`/assignments/${assignment.id}/plan/edit`}
                        className="rounded border border-neutral-700 px-2 py-1 text-xs text-neutral-300 hover:border-neutral-500 hover:text-neutral-100"
                      >
                        Edit plan
                      </Link>
                    </div>
                  </SectionCard>
                ) : (
                  <EmptyState
                    title="No plan file yet"
                    description="Create one via the CLI or `/plan-assignment`."
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
                {assignment.scratchpad ? (
                  <SectionCard>
                    <MarkdownRenderer content={assignment.scratchpad.body} emptyState="Scratchpad is empty." />
                    <div className="mt-3 flex justify-end">
                      <Link
                        to={`/assignments/${assignment.id}/scratchpad/edit`}
                        className="rounded border border-neutral-700 px-2 py-1 text-xs text-neutral-300 hover:border-neutral-500 hover:text-neutral-100"
                      >
                        Edit scratchpad
                      </Link>
                    </div>
                  </SectionCard>
                ) : (
                  <EmptyState
                    title="No scratchpad yet"
                    description="Scratchpad is scaffolded at assignment creation time."
                  />
                )}
              </div>
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
                    <div className="mt-3 flex justify-end">
                      <Link
                        to={`/assignments/${assignment.id}/handoff/edit`}
                        className="rounded border border-neutral-700 px-2 py-1 text-xs text-neutral-300 hover:border-neutral-500 hover:text-neutral-100"
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
            count: assignment.decisionRecord?.decisionCount ?? 0,
            content: (
              <div className="space-y-5">
                {assignment.decisionRecord ? (
                  <SectionCard>
                    <MarkdownRenderer content={assignment.decisionRecord.body} emptyState="No decision history yet." />
                    <div className="mt-3 flex justify-end">
                      <Link
                        to={`/assignments/${assignment.id}/decision-record/edit`}
                        className="rounded border border-neutral-700 px-2 py-1 text-xs text-neutral-300 hover:border-neutral-500 hover:text-neutral-100"
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
        ]}
      />
    </div>
  );
}

