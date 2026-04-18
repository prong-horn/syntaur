import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  Activity,
  ArrowUpRight,
  ExternalLink,
  FilePenLine,
  Hammer,
  NotebookPen,
  SendToBack,
  Trash2,
} from 'lucide-react';
import { CopyButton } from '../components/CopyButton';
import { useAssignment, useMission, useServers, useAssignmentSessions, useWorkspacePrefix, type AssignmentTransitionAction } from '../hooks/useMissions';
import { useStatusConfig } from '../hooks/useStatusConfig';
import { formatDateTime, formatRelativeTime, formatShortDate, formatShortDateTime } from '../lib/format';
import { LoadingState } from '../components/LoadingState';
import { ErrorState } from '../components/ErrorState';
import { StatusBadge } from '../components/StatusBadge';
import { ContentTabs } from '../components/ContentTabs';
import { SectionCard } from '../components/SectionCard';
import { MarkdownRenderer } from '../components/MarkdownRenderer';
import { EmptyState } from '../components/EmptyState';
import { AssignmentTransitionDialog } from '../components/AssignmentTransitionDialog';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { OverflowMenu, type OverflowMenuItem } from '../components/OverflowMenu';
import {
  deleteAssignment,
  runAssignmentTransition,
  overrideAssignmentStatus,
  transitionNeedsReason,
} from '../lib/assignments';
import { splitAssignmentSummary } from '../lib/acceptanceCriteria';
import { DependencyPanel } from '../components/DependencyPanel';
import { LinksPanel } from '../components/LinksPanel';
import { useHotkey, useHotkeyScope } from '../hotkeys';
import { cn } from '../lib/utils';

const TRANSITION_PRECEDENCE = ['review', 'complete', 'unblock', 'start', 'block', 'fail', 'reopen'] as const;

export function AssignmentDetail() {
  const { slug, aslug } = useParams<{ slug: string; aslug: string }>();
  const navigate = useNavigate();
  const wsPrefix = useWorkspacePrefix();
  const [searchParams, setSearchParams] = useSearchParams();
  const [transitionError, setTransitionError] = useState<string | null>(null);
  const [transitioning, setTransitioning] = useState<string | null>(null);
  const [pendingTransition, setPendingTransition] = useState<AssignmentTransitionAction | null>(null);
  const [criteriaError, setCriteriaError] = useState<string | null>(null);
  const [savingCriterionIndex, setSavingCriterionIndex] = useState<number | null>(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [reviewGlowKey, setReviewGlowKey] = useState(0);
  const tab = searchParams.get('tab') ?? 'summary';
  const statusConfig = useStatusConfig();
  const { data: assignment, loading, error, refetch } = useAssignment(slug, aslug);
  const { data: mission } = useMission(slug);
  const { data: serversData } = useServers();
  const { data: sessionsData } = useAssignmentSessions(slug, aslug);

  const enrichedDeps = useMemo(() => {
    if (!assignment || !mission) return [];
    const map = new Map(mission.assignments.map((a) => [a.slug, a]));
    return assignment.dependsOn.map((depSlug) => {
      const s = map.get(depSlug);
      return {
        slug: depSlug,
        title: s?.title ?? depSlug,
        status: s?.status ?? 'pending',
        priority: s?.priority ?? 'medium',
        assignee: s?.assignee ?? null,
      };
    });
  }, [assignment, mission]);

  const unmetDeps = enrichedDeps.filter(
    (d) => d.status !== 'completed' && d.status !== 'review',
  );

  // Hotkey wiring — scoped to 'assignment'.
  useHotkeyScope('assignment');
  const siblingSlugs = useMemo(
    () => (mission?.assignments ?? []).map((a) => a.slug),
    [mission],
  );
  const currentIndex = aslug ? siblingSlugs.indexOf(aslug) : -1;
  const prevSlug = currentIndex > 0 ? siblingSlugs[currentIndex - 1] : null;
  const nextSlug =
    currentIndex >= 0 && currentIndex < siblingSlugs.length - 1
      ? siblingSlugs[currentIndex + 1]
      : null;
  const baseRoute = `${wsPrefix}/missions/${slug}/assignments/${aslug}`;

  useHotkey({
    keys: 'e',
    scope: 'assignment',
    description: 'Edit assignment',
    handler: () => navigate(`${baseRoute}/edit`),
  });
  useHotkey({
    keys: 'p',
    scope: 'assignment',
    description: 'Edit plan',
    handler: () => navigate(`${baseRoute}/plan/edit`),
  });
  useHotkey({
    keys: 'h',
    scope: 'assignment',
    description: 'Append handoff',
    handler: () => navigate(`${baseRoute}/handoff/edit`),
  });
  useHotkey({
    keys: 'd',
    scope: 'assignment',
    description: 'Append decision record',
    handler: () => navigate(`${baseRoute}/decision-record/edit`),
  });
  useHotkey({
    keys: 's',
    scope: 'assignment',
    description: 'Edit scratchpad',
    handler: () => navigate(`${baseRoute}/scratchpad/edit`),
  });
  useHotkey({
    keys: '[',
    scope: 'assignment',
    description: 'Previous assignment in mission',
    enabled: !!prevSlug,
    handler: () =>
      prevSlug && navigate(`${wsPrefix}/missions/${slug}/assignments/${prevSlug}`),
  });
  useHotkey({
    keys: ']',
    scope: 'assignment',
    description: 'Next assignment in mission',
    enabled: !!nextSlug,
    handler: () =>
      nextSlug && navigate(`${wsPrefix}/missions/${slug}/assignments/${nextSlug}`),
  });

  const summarySections = useMemo(
    () => (assignment ? splitAssignmentSummary(assignment.body) : { acceptanceCriteria: [], summaryBody: '' }),
    [assignment],
  );
  const criteria = summarySections.acceptanceCriteria;
  const checkedCount = criteria.filter((c) => c.checked).length;
  const allChecked = criteria.length > 0 && checkedCount === criteria.length;
  const prevAllCheckedRef = useRef(allChecked);
  const initialSyncDoneRef = useRef(false);

  useEffect(() => {
    // Wait until the assignment payload has loaded before treating any state as a transition.
    // Without this guard, the initial empty-criteria render (allChecked === false) followed by
    // the post-fetch render (allChecked === true) reads as a "just became all-checked" event
    // and fires the glow on page load for already-complete assignments.
    if (!assignment) return;
    if (!initialSyncDoneRef.current) {
      prevAllCheckedRef.current = allChecked;
      initialSyncDoneRef.current = true;
      return;
    }
    if (allChecked && !prevAllCheckedRef.current) {
      setReviewGlowKey((n) => n + 1);
    }
    prevAllCheckedRef.current = allChecked;
  }, [allChecked, assignment]);

  if (loading) {
    return <LoadingState label="Loading assignment workspace…" />;
  }

  if (error || !assignment || !slug || !aslug) {
    return <ErrorState error={error || 'Assignment not found.'} />;
  }

  const missionSlug = slug;
  const assignmentSlug = aslug;
  const progress = criteria.length > 0 ? { checked: checkedCount, total: criteria.length } : undefined;

  const transitions = assignment.availableTransitions ?? [];
  // Exclude same-target transitions: the backend currently returns every command as enabled
  // even when the targetStatus equals the current status, which would produce a meaningless
  // idempotent primary action. Filter those out for the primary slot; they still surface in
  // the overflow menu as disabled with "Already in this status".
  const enabledTransitions = transitions.filter(
    (a) => !a.disabled && a.targetStatus !== assignment.status,
  );
  const primaryTransition =
    TRANSITION_PRECEDENCE.map((cmd) => enabledTransitions.find((a) => a.command === cmd)).find(Boolean) ??
    enabledTransitions[0] ??
    null;

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

  async function handleDeleteAssignment() {
    setDeleteLoading(true);
    try {
      await deleteAssignment(missionSlug, assignmentSlug);
      navigate(`${wsPrefix}/missions/${missionSlug}`);
    } catch (err) {
      setTransitionError((err as Error).message);
      setDeleteLoading(false);
      setShowDeleteConfirm(false);
    }
  }

  async function runTransition(action: AssignmentTransitionAction, reason?: string): Promise<boolean> {
    setTransitionError(null);
    setTransitioning(action.command);

    try {
      await runAssignmentTransition(missionSlug, assignmentSlug, action, reason);
      refetch();
      return true;
    } catch (mutationError) {
      setTransitionError((mutationError as Error).message);
      return false;
    } finally {
      setTransitioning(null);
    }
  }

  function handleTransitionClick(action: AssignmentTransitionAction) {
    if (transitionNeedsReason(action)) {
      setPendingTransition(action);
      return;
    }

    void runTransition(action);
  }

  async function toggleAcceptanceCriterion(index: number, checked: boolean) {
    setCriteriaError(null);
    setSavingCriterionIndex(index);

    try {
      const response = await fetch(
        `/api/missions/${missionSlug}/assignments/${assignmentSlug}/acceptance-criteria/${index}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ checked }),
        },
      );
      const payload = await response.json();

      if (!response.ok) {
        throw new Error(payload.error || `HTTP ${response.status}`);
      }

      refetch();
    } catch (mutationError) {
      setCriteriaError((mutationError as Error).message);
    } finally {
      setSavingCriterionIndex(null);
    }
  }

  const overflowItems: OverflowMenuItem[] = [
    ...enabledTransitions
      .filter((a) => a !== primaryTransition)
      .map<OverflowMenuItem>((action) => ({
        key: `transition-${action.command}`,
        label: action.label,
        onSelect: () => handleTransitionClick(action),
        disabled: transitioning === action.command,
      })),
    ...transitions
      .filter((a) => a.disabled || a.targetStatus === assignment.status)
      .map<OverflowMenuItem>((action) => ({
        key: `transition-${action.command}`,
        label: action.label,
        disabled: true,
        disabledReason:
          action.targetStatus === assignment.status
            ? `Already ${assignment.status.replace(/_/g, ' ')}`
            : action.disabledReason ?? action.warning ?? action.description,
      })),
    ...statusConfig.statuses.map<OverflowMenuItem>((s) => ({
      key: `override-${s.id}`,
      label: `Override → ${s.label}`,
      onSelect: () => handleStatusOverride(s.id),
      disabled: s.id === assignment.status,
      disabledReason: s.id === assignment.status ? 'Already in this status' : undefined,
    })),
    {
      key: 'edit-assignment',
      label: 'Edit assignment source',
      icon: FilePenLine,
      href: `${wsPrefix}/missions/${slug}/assignments/${aslug}/edit`,
    },
    {
      key: 'edit-plan',
      label: 'Edit plan',
      icon: SendToBack,
      href: `${wsPrefix}/missions/${slug}/assignments/${aslug}/plan/edit`,
    },
    {
      key: 'edit-scratchpad',
      label: 'Edit scratchpad',
      icon: NotebookPen,
      href: `${wsPrefix}/missions/${slug}/assignments/${aslug}/scratchpad/edit`,
    },
    {
      key: 'append-handoff',
      label: 'Append handoff',
      icon: ArrowUpRight,
      href: `${wsPrefix}/missions/${slug}/assignments/${aslug}/handoff/edit`,
    },
    {
      key: 'append-decision',
      label: 'Append decision',
      icon: Hammer,
      href: `${wsPrefix}/missions/${slug}/assignments/${aslug}/decision-record/edit`,
    },
    {
      key: 'delete',
      label: 'Delete assignment',
      icon: Trash2,
      destructive: true,
      onSelect: () => setShowDeleteConfirm(true),
    },
  ];

  const primaryIsReview = primaryTransition?.command === 'review';

  return (
    <div className="space-y-5">
      <div className="sticky top-12 z-20 rounded-lg border border-border/60 bg-card/90 p-3 shadow-sm backdrop-blur">
        <div className="flex flex-wrap items-center gap-3">
          <StatusBadge status={assignment.status} progress={progress} />
          <h1 className="text-lg font-semibold text-foreground">{assignment.title}</h1>
          <span className="text-xs text-muted-foreground">
            Updated {formatRelativeTime(assignment.updated)}
          </span>
          {unmetDeps.length > 0 && (
            <span className="text-xs text-amber-700 dark:text-amber-300">
              ⚠ {unmetDeps.length} unmet dep{unmetDeps.length === 1 ? '' : 's'}
            </span>
          )}
          <span className="ml-auto flex items-center gap-2">
            {primaryTransition && (
              <button
                key={primaryIsReview ? `review-${reviewGlowKey}` : primaryTransition.command}
                type="button"
                title={primaryTransition.warning || primaryTransition.description}
                disabled={transitioning === primaryTransition.command}
                onClick={() => handleTransitionClick(primaryTransition)}
                className={cn(
                  'shell-action disabled:cursor-not-allowed disabled:opacity-50',
                  primaryTransition.warning && 'border-amber-300 dark:border-amber-700',
                  primaryIsReview && reviewGlowKey > 0 && 'send-to-review-glow',
                )}
              >
                <span>
                  {transitioning === primaryTransition.command ? 'Working…' : primaryTransition.label}
                </span>
              </button>
            )}
            <OverflowMenu items={overflowItems} align="end" />
          </span>
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
      </div>

      {enrichedDeps.length > 0 && (
        <DependencyPanel
          missionSlug={slug!}
          dependencies={enrichedDeps}
          blockedReason={assignment.blockedReason}
        />
      )}

      {assignment.enrichedLinks && assignment.enrichedLinks.length > 0 && (
        <LinksPanel links={assignment.enrichedLinks} />
      )}

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
                    {summarySections.acceptanceCriteria.length > 0 ? (
                      <SectionCard
                        title="Acceptance Criteria"
                        description="These checkboxes update the source assignment markdown."
                      >
                        <div className="space-y-3">
                          {criteriaError ? (
                            <p className="rounded-md border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700 dark:border-rose-900 dark:bg-rose-950/30 dark:text-rose-300">
                              {criteriaError}
                            </p>
                          ) : null}
                          {summarySections.acceptanceCriteria.map((criterion, index) => {
                            const disabled = savingCriterionIndex !== null;
                            return (
                              <label
                                key={`${index}-${criterion.text}`}
                                className="flex items-start gap-3 rounded-md border border-border/60 bg-background/80 px-3 py-3"
                              >
                                <input
                                  type="checkbox"
                                  checked={criterion.checked}
                                  disabled={disabled}
                                  onChange={(event) => toggleAcceptanceCriterion(index, event.target.checked)}
                                  className="mt-1 h-4 w-4 rounded border-border text-primary"
                                />
                                <span
                                  className="criterion-label text-sm leading-6"
                                  data-checked={criterion.checked}
                                >
                                  {criterion.text}
                                </span>
                              </label>
                            );
                          })}
                        </div>
                      </SectionCard>
                    ) : null}

                    <SectionCard title="Assignment Summary">
                      <MarkdownRenderer
                        content={summarySections.summaryBody}
                        emptyState={
                          summarySections.acceptanceCriteria.length > 0
                            ? 'No additional summary markdown beyond the acceptance criteria.'
                            : 'This assignment does not have summary markdown yet.'
                        }
                      />
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
                        <Link className="shell-action" to={`${wsPrefix}/missions/${slug}/assignments/${aslug}/plan/edit`}>
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
                      <Link className="shell-action" to={`${wsPrefix}/missions/${slug}/assignments/${aslug}/scratchpad/edit`}>
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
                    description="Scratchpad notes appear here when you use the Edit Scratchpad action."
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
                        description="Handoffs appear here when an agent runs /complete-assignment or you append one manually."
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
                        description="Decision records appear here when you append one via the Append Decision action."
                      />
                    )}
                  </div>
                ),
              },
            ]}
          />
        </div>

        <div className="space-y-5">
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

          {sessionsData && sessionsData.sessions.length > 0 && (
            <SectionCard title="Agent Sessions">
              <div className="space-y-2">
                {sessionsData.sessions.map((session) => (
                  <div key={session.sessionId} className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
                    <span className="flex items-center gap-1.5">
                      <Activity className="h-3 w-3 shrink-0 text-muted-foreground" />
                      <span className="font-medium text-foreground">{session.agent}</span>
                      <span className="inline-flex items-center gap-1.5 font-mono text-xs text-muted-foreground" title={session.sessionId}>
                        {session.sessionId.slice(0, 8)}
                        <CopyButton value={session.sessionId} />
                      </span>
                    </span>
                    <span className="flex items-center gap-2">
                      <StatusBadge status={session.status} />
                      <span className="text-xs text-muted-foreground">
                        {formatDateTime(session.started)}
                      </span>
                    </span>
                  </div>
                ))}
              </div>
            </SectionCard>
          )}
        </div>
      </div>

      <AssignmentTransitionDialog
        open={pendingTransition !== null}
        action={pendingTransition}
        assignmentTitle={assignment.title}
        loading={transitioning === pendingTransition?.command}
        onOpenChange={(open) => {
          if (!open) {
            setPendingTransition(null);
          }
        }}
        onConfirm={async (reason) => {
          if (!pendingTransition) {
            return;
          }

          const action = pendingTransition;
          const succeeded = await runTransition(action, reason);
          if (succeeded) {
            setPendingTransition(null);
          }
        }}
      />

      <ConfirmDialog
        open={showDeleteConfirm}
        title="Delete assignment?"
        description={`This will permanently delete "${assignment.title}" and all its files (plan, scratchpad, handoff, decision record). This cannot be undone.`}
        confirmLabel="Delete Assignment"
        destructive
        loading={deleteLoading}
        onOpenChange={(open) => {
          if (!open) setShowDeleteConfirm(false);
        }}
        onConfirm={handleDeleteAssignment}
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
        {copyable && value !== '\u2014' && <CopyButton value={value} />}
      </dd>
    </div>
  );
}
