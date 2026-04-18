import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  Activity,
  ArrowUpRight,
  BookOpenText,
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
import { formatDateTime } from '../lib/format';
import { LoadingState } from '../components/LoadingState';
import { ErrorState } from '../components/ErrorState';
import { StatusBadge } from '../components/StatusBadge';
import { ContentTabs } from '../components/ContentTabs';
import { SectionCard } from '../components/SectionCard';
import { MarkdownRenderer } from '../components/MarkdownRenderer';
import { EmptyState } from '../components/EmptyState';
import { AssignmentTransitionDialog } from '../components/AssignmentTransitionDialog';
import { ConfirmDialog } from '../components/ConfirmDialog';
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

  if (loading) {
    return <LoadingState label="Loading assignment workspace…" />;
  }

  if (error || !assignment || !slug || !aslug) {
    return <ErrorState error={error || 'Assignment not found.'} />;
  }

  const missionSlug = slug;
  const assignmentSlug = aslug;
  const summarySections = splitAssignmentSummary(assignment.body);

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

  return (
    <div className="space-y-5">
      <div className="sticky top-12 z-20 rounded-lg border border-border/60 bg-card/90 p-3 shadow-sm backdrop-blur">
        <div className="flex flex-wrap items-center gap-3">
          <StatusBadge status={assignment.status} />
          <Link className="shell-action" to={`${wsPrefix}/missions/${slug}`}>
            Mission
          </Link>
          <Link className="shell-action" to={`${wsPrefix}/missions/${slug}/assignments/${aslug}/edit`}>
            <FilePenLine className="h-4 w-4" />
            <span>Edit Assignment</span>
          </Link>
          <span className="text-xs text-muted-foreground">Mission {slug} · Updated {formatDateTime(assignment.updated)}</span>
        </div>

        <div className="mt-5 flex flex-wrap gap-2">
          {(assignment.availableTransitions ?? []).map((action) => (
            <button
              key={action.command}
              type="button"
              title={action.warning || action.disabledReason || action.description}
              disabled={action.disabled || transitioning === action.command}
              onClick={() => handleTransitionClick(action)}
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
            {statusConfig.statuses.map((s) => (
              <option key={s.id} value={s.id}>{s.label}</option>
            ))}
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
          <Chip label={`${assignment.dependsOn.length} dependencies`} variant={unmetDeps.length > 0 ? 'warning' : enrichedDeps.length > 0 ? 'success' : 'default'} />
          <Chip label={assignment.plan ? `Plan ${assignment.plan.status}` : 'No plan'} />
          <Chip label={`${assignment.handoff?.handoffCount ?? 0} handoffs`} />
          <Chip label={`${assignment.decisionRecord?.decisionCount ?? 0} decisions`} />
          <Chip label={isStale(assignment.updated) ? 'Stale' : 'Fresh'} />
        </div>
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
                                <span className={`text-sm leading-6 ${criterion.checked ? 'text-muted-foreground line-through' : 'text-foreground'}`}>
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
              <DetailRow label="ID" value={assignment.id} copyable />
              <DetailRow label="Priority" value={assignment.priority} />
              <DetailRow label="Assignee" value={assignment.assignee ?? 'Unassigned'} />
              <DetailRow label="Created" value={formatDateTime(assignment.created)} />
              <DetailRow label="Updated" value={formatDateTime(assignment.updated)} />
              <DetailRow label="Status" value={assignment.status} />
            </dl>
          </SectionCard>

          <SectionCard title="Workspace Info">
            <dl className="space-y-3 text-sm">
              <DetailRow label="Repository" value={assignment.workspace.repository ?? '\u2014'} copyable />
              <DetailRow label="Worktree" value={assignment.workspace.worktreePath ?? '\u2014'} copyable />
              <DetailRow label="Branch" value={assignment.workspace.branch ?? '\u2014'} copyable />
              <DetailRow label="Parent branch" value={assignment.workspace.parentBranch ?? '\u2014'} copyable />
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

          <SectionCard title="Edit Actions">
            <div className="space-y-2 text-sm">
              <Link className="flex items-center gap-2 text-primary hover:underline" to={`${wsPrefix}/missions/${slug}/assignments/${aslug}/edit`}>
                <FilePenLine className="h-4 w-4" />
                Edit assignment source
              </Link>
              <Link className="flex items-center gap-2 text-primary hover:underline" to={`${wsPrefix}/missions/${slug}/assignments/${aslug}/plan/edit`}>
                <SendToBack className="h-4 w-4" />
                Edit plan
              </Link>
              <Link className="flex items-center gap-2 text-primary hover:underline" to={`${wsPrefix}/missions/${slug}/assignments/${aslug}/scratchpad/edit`}>
                <NotebookPen className="h-4 w-4" />
                Edit scratchpad
              </Link>
              <Link className="flex items-center gap-2 text-primary hover:underline" to={`${wsPrefix}/missions/${slug}/assignments/${aslug}/handoff/edit`}>
                <ArrowUpRight className="h-4 w-4" />
                Append handoff
              </Link>
              <Link className="flex items-center gap-2 text-primary hover:underline" to={`${wsPrefix}/missions/${slug}/assignments/${aslug}/decision-record/edit`}>
                <Hammer className="h-4 w-4" />
                Append decision
              </Link>
              <hr className="border-border/40" />
              <button
                type="button"
                onClick={() => setShowDeleteConfirm(true)}
                className="flex items-center gap-2 text-destructive hover:underline"
              >
                <Trash2 className="h-4 w-4" />
                Delete assignment
              </button>
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

function Chip({ label, variant = 'default' }: { label: string; variant?: 'default' | 'warning' | 'success' }) {
  const cls = {
    default: 'border-border/60 bg-background/80 text-muted-foreground',
    warning: 'border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-300',
    success: 'border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-300',
  }[variant];
  return (
    <span className={`rounded-full border px-3 py-1 text-xs font-medium ${cls}`}>
      {label}
    </span>
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
