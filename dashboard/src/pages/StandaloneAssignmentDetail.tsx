import { useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { Archive, ArchiveRestore, ArrowRightLeft, ExternalLink } from 'lucide-react';
import { useAssignmentById, useAssignmentSessionsById, useStandaloneAssignmentUsage, type ExternalIdInfo } from '../hooks/useProjects';
import { LoadingState } from '../components/LoadingState';
import { ErrorState } from '../components/ErrorState';
import { StatusBadge } from '../components/StatusBadge';
import { TypeChip } from '../components/TypeChip';
import { ExternalIdBadges } from '../components/ExternalIdBadges';
import { CopyButton } from '../components/CopyButton';
import { formatShortDate, formatShortDateTime } from '../lib/format';
import { ContentTabs } from '../components/ContentTabs';
import { SectionCard } from '../components/SectionCard';
import { MarkdownRenderer } from '../components/MarkdownRenderer';
import { EmptyState } from '../components/EmptyState';
import { CommentsThread } from '../components/CommentsThread';
import { MoveToWorkspaceDialog } from '../components/MoveToWorkspaceDialog';
import { AgentSessionsSection } from '../components/AgentSessionsSection';
import { AssignmentUsageSection } from '../components/AssignmentUsageSection';
import { OpenInAgentButton } from '../components/OpenInAgentButton';
import { CreateWorktreeButton } from '../components/CreateWorktreeButton';
import { useToast, Toaster } from '../components/Toast';
import { useHashScroll } from '../hooks/useHashScroll';

/**
 * Read-and-edit view for standalone assignments (those at
 * `~/.syntaur/assignments/<uuid>/`). Edit links route to the shared editor pages.
 */
export function StandaloneAssignmentDetail() {
  const { id } = useParams<{ id: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = searchParams.get('tab') ?? 'summary';
  // Standalone hits can carry `#section` too — honor the deep-link hash.
  useHashScroll(tab);
  const { data: assignment, loading, error, refetch } = useAssignmentById(id);
  const { data: sessionsData, loading: sessionsLoading, error: sessionsError } = useAssignmentSessionsById(id);
  // D3: the standalone usage endpoint keys on the assignment SLUG, not the UUID
  // `id`. `assignment` is undefined until loaded, so gate on `assignment?.slug`.
  const { data: usageData, loading: usageLoading, error: usageError } = useStandaloneAssignmentUsage(assignment?.slug);
  const [moveOpen, setMoveOpen] = useState(false);
  const [archiveError, setArchiveError] = useState<string | null>(null);
  const { toast, showToast, dismissToast } = useToast();

  async function handleArchive(archived: boolean) {
    if (!id) return;
    setArchiveError(null);
    try {
      const res = await fetch(`/api/assignments/${id}/${archived ? 'archive' : 'unarchive'}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => null);
        throw new Error(payload?.error || `HTTP ${res.status}`);
      }
      refetch();
      showToast(archived ? 'Assignment archived' : 'Assignment restored', 'success');
    } catch (err) {
      setArchiveError(err instanceof Error ? err.message : 'Archive failed');
    }
  }

  if (loading) return <LoadingState />;
  if (error) return <ErrorState error={error} />;
  if (!assignment) return <ErrorState error="Assignment not found" />;

  return (
    <div className="space-y-6">
      <Toaster toast={toast} onDismiss={dismissToast} />
      <header className="space-y-2">
        <div className="flex flex-wrap items-center gap-3">
          <StatusBadge status={assignment.status} />
          <TypeChip type={assignment.type} />
          <span className="text-xs font-mono text-muted-foreground">{assignment.id}</span>
          <ExternalIdBadges externalIds={assignment.externalIds} />
          <div className="ml-auto flex items-center gap-2">
            <OpenInAgentButton
              target={{ kind: 'assignment', id: assignment.id }}
              worktreePath={assignment.workspace?.worktreePath ?? null}
              repository={assignment.workspace?.repository ?? null}
              size="compact"
            />
            {!assignment.workspace?.worktreePath && (
              <CreateWorktreeButton
                assignmentId={assignment.id}
                defaultBranch={`syntaur/${assignment.slug}`}
                onCreated={() => refetch()}
              />
            )}
            <button
              type="button"
              onClick={() => setMoveOpen(true)}
              className="inline-flex items-center gap-1.5 rounded border border-border px-2 py-1 text-xs text-muted-foreground hover:border-foreground/40 hover:text-foreground"
            >
              <ArrowRightLeft className="h-3 w-3" />
              Move to workspace…
            </button>
            <Link
              to={`/assignments/${assignment.id}/edit`}
              className="rounded border border-border px-2 py-1 text-xs text-muted-foreground hover:border-foreground/40 hover:text-foreground"
            >
              Edit
            </Link>
            <button
              type="button"
              onClick={() => handleArchive(!assignment.archived)}
              className="inline-flex items-center gap-1.5 rounded border border-border px-2 py-1 text-xs text-muted-foreground hover:border-foreground/40 hover:text-foreground"
              title={assignment.archived ? 'Restore this assignment' : 'Archive this assignment'}
            >
              {assignment.archived ? <ArchiveRestore className="h-3 w-3" /> : <Archive className="h-3 w-3" />}
              {assignment.archived ? 'Restore' : 'Archive'}
            </button>
          </div>
        </div>
        <h1 className="text-2xl font-semibold text-foreground">{assignment.title}</h1>
        {assignment.blockedReason ? (
          <p className="text-sm text-warning-foreground">Blocked: {assignment.blockedReason}</p>
        ) : null}
        {archiveError ? (
          <p className="text-sm text-status-failed-foreground">{archiveError}</p>
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
                            className="rounded border border-border px-2 py-1 text-xs text-muted-foreground hover:border-foreground/40 hover:text-foreground"
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
                            className="rounded border border-border px-2 py-1 text-xs text-muted-foreground hover:border-foreground/40 hover:text-foreground"
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
                count: assignment.decisionRecord?.decisionCount ?? 0,
                content: (
                  <div className="space-y-5">
                    {assignment.decisionRecord ? (
                      <SectionCard>
                        <MarkdownRenderer content={assignment.decisionRecord.body} emptyState="No decision history yet." />
                        <div className="mt-3 flex justify-end">
                          <Link
                            to={`/assignments/${assignment.id}/decision-record/edit`}
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
            ]}
          />
        </div>

        <div className="min-w-0 space-y-5">
          <SectionCard title="Details">
            <dl className="space-y-3 text-sm">
              <DetailRow label="ID" value={assignment.id} copyable />
              <DetailRow label="Priority" value={assignment.priority} />
              {assignment.assignee && <DetailRow label="Assignee" value={assignment.assignee} />}
              <DetailRow
                label="Updated"
                value={`${formatShortDateTime(assignment.updated)} · Created ${formatShortDate(assignment.created)}`}
              />
              {assignment.workspace.repository && (
                <DetailRow label="Repository" value={assignment.workspace.repository} copyable />
              )}
              {assignment.workspace.worktreePath && (
                <DetailRow label="Worktree" value={assignment.workspace.worktreePath} copyable />
              )}
              {assignment.workspace.branch && (
                <DetailRow label="Branch" value={assignment.workspace.branch} copyable />
              )}
              {assignment.workspace.parentBranch && (
                <DetailRow label="Parent branch" value={assignment.workspace.parentBranch} copyable />
              )}
              {assignment.externalIds.map((entry, idx) => (
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

          <AssignmentUsageSection
            summary={usageData?.summary}
            loading={usageLoading}
            error={usageError}
          />
        </div>
      </div>

      <MoveToWorkspaceDialog
        open={moveOpen}
        onOpenChange={setMoveOpen}
        currentWorkspace={assignment.projectWorkspace}
        title="Move assignment to workspace"
        description="Standalone assignments belong to a project-workspace via the workspaceGroup frontmatter field."
        onSubmit={async (target) => {
          const res = await fetch(`/api/assignments/${encodeURIComponent(assignment.id)}/move-workspace`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ workspaceGroup: target }),
          });
          if (!res.ok) {
            const body = await res.json().catch(() => ({}));
            throw new Error(body.error || 'Failed to move assignment');
          }
          refetch();
        }}
      />
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

