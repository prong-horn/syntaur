import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  FilePenLine,
  NotebookPen,
  SendToBack,
  Trash2,
} from 'lucide-react';
import { CopyButton } from '../components/CopyButton';
import { useTicket, useProject, useTicketSessions, useTicketUsage, type TicketTransitionAction } from '../hooks/useProjects';
import { ticketEditHref, ticketPageHref } from '../lib/routes';
import { useTicketEvents } from '../hooks/useTicketEvents';
import { formatShortDate, formatShortDateTime } from '../lib/format';
import { LoadingState } from '../components/LoadingState';
import { ErrorState } from '../components/ErrorState';
import { TicketStatusPill } from '../components/TicketStatusPill';
import { TemplateChip } from '../components/TemplateChip';
import { ContentTabs } from '../components/ContentTabs';
import { SectionCard } from '../components/SectionCard';
import { MarkdownRenderer } from '../components/MarkdownRenderer';
import { EmptyState } from '../components/EmptyState';
import { AgentSessionsSection } from '../components/AgentSessionsSection';
import { TicketUsageSection } from '../components/TicketUsageSection';
import { TicketTransitionDialog } from '../components/TicketTransitionDialog';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { OverflowMenu, type OverflowMenuItem } from '../components/OverflowMenu';
import { CreateWorktreeButton } from '../components/CreateWorktreeButton';
import {
  deleteTicket,
  dispatchVerbMessages,
  runTicketVerb,
  transitionNeedsReason,
} from '../lib/tickets';
import { StartAgentPicker, resolveStartAgentOverride } from '../components/StartAgentPicker';
import { StageHandoffControl } from '../components/StageHandoffControl';
import { useStageDispatch } from '../hooks/useStageDispatch';
import { pickPrimaryVerb, pickSecondaryVerbs } from '../lib/verbActions';
import { splitTicketSummary } from '../lib/acceptanceCriteria';
import { DependencyPanel } from '../components/DependencyPanel';
import { LinksPanel } from '../components/LinksPanel';
import { ActivityTimeline } from '../components/ActivityTimeline';
import { SessionActivityTimeline } from '../components/SessionActivityTimeline';
import { ChatTab } from '../components/chat/ChatTab';
import { JournalTab } from '../components/JournalTab';
import { buildTicketTabs, templateFileEditSection } from '../lib/ticketTabs';
import type { TicketTabSpec } from '../lib/ticketTabs';
import type { TicketTemplateFileDetail } from '../hooks/useProjects';
import { useHotkey, useHotkeyScope } from '../hotkeys';
import { useHashScroll } from '../hooks/useHashScroll';
import { cn } from '../lib/utils';
import { useToast, Toaster } from '../components/Toast';

/** Ticket detail for project-nested tickets at `/t/:id`. */
export function TicketDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [transitionError, setTransitionError] = useState<string | null>(null);
  const { toast, showToast, dismissToast } = useToast();
  const [transitioning, setTransitioning] = useState<string | null>(null);
  const [pendingTransition, setPendingTransition] = useState<TicketTransitionAction | null>(null);
  const [criteriaError, setCriteriaError] = useState<string | null>(null);
  const [savingCriterionIndex, setSavingCriterionIndex] = useState<number | null>(null);
  // Optimistic overlay for acceptance-criterion checkboxes, keyed by index.
  // Set immediately on toggle, removed on error (reverting to server state), and
  // cleared wholesale once fresh ticket data lands (server is source of truth).
  const [optimisticChecks, setOptimisticChecks] = useState<Record<number, boolean>>({});
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [reviewGlowKey, setReviewGlowKey] = useState(0);
  const [startAgentOverride, setStartAgentOverride] = useState<string | null>(null);
  const tab = searchParams.get('tab') ?? 'summary';
  // Honor `#section` deep-links from the command palette once the pane renders.
  useHashScroll(tab);
  const { data: ticket, loading, error, refetch } = useTicket(id);
  const projectSlug = ticket?.projectSlug ?? undefined;
  const { data: project } = useProject(projectSlug);
  const { data: sessionsData, loading: sessionsLoading, error: sessionsError } = useTicketSessions(id);
  const { data: usageData, loading: usageLoading, error: usageError } = useTicketUsage(id);
  const {
    events,
    loading: eventsLoading,
    error: eventsError,
    refetch: refetchEvents,
  } = useTicketEvents(id);

  const stageDispatch = useStageDispatch({
    ticketId: id ?? '',
    descriptor: ticket?.stageHandoff,
    onTicketRefetch: refetch,
  });

  useEffect(() => {
    setStartAgentOverride(null);
  }, [id]);

  const enrichedDeps = useMemo(() => {
    if (!ticket || !project) return [];
    const map = new Map(project.tickets.map((a) => [a.slug, a]));
    return ticket.depends_on.map((depSlug) => {
      const s = map.get(depSlug);
      return {
        id: s?.id ?? depSlug,
        slug: depSlug,
        title: s?.title ?? depSlug,
        status: s?.status ?? 'pending',
        priority: s?.priority ?? 'medium',
        assignee: s?.assignee ?? null,
      };
    });
  }, [ticket, project]);

  const unmetDeps = enrichedDeps.filter(
    (d) => d.status !== 'completed' && d.status !== 'review',
  );

  // Hotkey wiring — scoped to 'ticket'.
  useHotkeyScope('ticket');
  const siblingIds = useMemo(
    () => (project?.tickets ?? []).map((a) => a.id),
    [project],
  );
  const currentIndex = id ? siblingIds.indexOf(id) : -1;
  const prevId = currentIndex > 0 ? siblingIds[currentIndex - 1] : null;
  const nextId =
    currentIndex >= 0 && currentIndex < siblingIds.length - 1
      ? siblingIds[currentIndex + 1]
      : null;
  useHotkey({
    keys: 'e',
    scope: 'ticket',
    description: 'Edit ticket',
    handler: () => id && navigate(ticketEditHref(id)),
  });
  useHotkey({
    keys: 'p',
    scope: 'ticket',
    description: 'Edit plan',
    handler: () => id && navigate(ticketEditHref(id, 'plan')),
  });
  useHotkey({
    keys: 's',
    scope: 'ticket',
    description: 'Edit scratchpad',
    handler: () => id && navigate(ticketEditHref(id, 'scratchpad')),
  });
  useHotkey({
    keys: '[',
    scope: 'ticket',
    description: 'Previous ticket in project',
    enabled: !!prevId,
    handler: () => prevId && navigate(ticketPageHref(prevId)),
  });
  useHotkey({
    keys: ']',
    scope: 'ticket',
    description: 'Next ticket in project',
    enabled: !!nextId,
    handler: () => nextId && navigate(ticketPageHref(nextId)),
  });

  const summarySections = useMemo(
    () => (ticket ? splitTicketSummary(ticket.body) : { acceptanceCriteria: [], summaryBody: '' }),
    [ticket],
  );

  const tabItems = useMemo(() => {
    if (!ticket || !id) return [];
    const renderFileTab = (file: TicketTemplateFileDetail) => {
      if (!file.exists) {
        return (
          <EmptyState
            title={`Not created yet (createOn: ${file.createOn})`}
            description=""
          />
        );
      }
      const editSection = templateFileEditSection(file.path);
      const editAction = editSection ? (
        <Link className="shell-action" to={ticketEditHref(id, editSection)}>
          <NotebookPen className="h-4 w-4" />
          <span>Edit</span>
        </Link>
      ) : undefined;

      if (file.role === 'log') {
        return (
          <JournalTab ticketId={id} file={file} onAppended={() => void refetch()} />
        );
      }

      if (file.role === 'plan') {
        return (
          <SectionCard title="Plan" description={file.description} actions={editAction}>
            <div className="mb-4">
              <span className="rounded-full border border-border px-2 py-0.5 text-xs font-medium capitalize">
                {file.state}
              </span>
              {file.planStatus ? (
                <span className="ml-2 text-xs text-muted-foreground">status: {file.planStatus}</span>
              ) : null}
            </div>
            <MarkdownRenderer content={file.body ?? ''} emptyState="No plan content yet." />
          </SectionCard>
        );
      }

      return (
        <SectionCard title={file.path} description={file.description} actions={editAction}>
          <MarkdownRenderer content={file.body ?? ''} emptyState="No content yet." />
        </SectionCard>
      );
    };

    return buildTicketTabs(ticket).map((spec: TicketTabSpec) => {
      if (spec.kind === 'summary') {
        return {
          value: spec.value,
          label: spec.label,
          content: (
            <div className="space-y-5">
              {summarySections.acceptanceCriteria.length > 0 ? (
                <SectionCard
                  title="Acceptance Criteria"
                  description="These checkboxes update the source ticket markdown."
                >
                  <div className="space-y-3">
                    {criteriaError ? (
                      <p className="rounded-md border border-error-foreground/30 bg-error px-4 py-3 text-sm text-error-foreground">
                        {criteriaError}
                      </p>
                    ) : null}
                    {summarySections.acceptanceCriteria.map((criterion, index) => {
                      const disabled = savingCriterionIndex !== null;
                      const effectiveChecked =
                        index in optimisticChecks
                          ? optimisticChecks[index]
                          : criterion.checked;
                      return (
                        <label
                          key={`${index}-${criterion.text}`}
                          className="flex items-start gap-3 rounded-md border border-border/60 bg-background/80 px-3 py-3"
                        >
                          <input
                            type="checkbox"
                            checked={effectiveChecked}
                            disabled={disabled}
                            onChange={(event) => toggleAcceptanceCriterion(index, event.target.checked)}
                            className="mt-1 h-4 w-4 rounded border-border text-primary"
                          />
                          <span
                            className="criterion-label text-sm leading-6"
                            data-checked={effectiveChecked}
                          >
                            {criterion.text}
                          </span>
                        </label>
                      );
                    })}
                  </div>
                </SectionCard>
              ) : null}
              <SectionCard title="Ticket Summary">
                <MarkdownRenderer
                  content={summarySections.summaryBody}
                  emptyState={
                    summarySections.acceptanceCriteria.length > 0
                      ? 'No additional summary markdown beyond the acceptance criteria.'
                      : 'This ticket does not have summary markdown yet.'
                  }
                />
              </SectionCard>
            </div>
          ),
        };
      }
      if (spec.kind === 'chat') {
        return { value: spec.value, label: spec.label, content: <ChatTab ticketId={ticket.id} /> };
      }
      if (spec.kind === 'template-file' && spec.file) {
        return {
          value: spec.value,
          label: spec.label,
          count: spec.count,
          badge: spec.badge,
          content: renderFileTab(spec.file),
        };
      }
      if (spec.kind === 'activity') {
        return {
          value: spec.value,
          label: spec.label,
          count: events.length,
          content: (
            <div className="space-y-5">
              <ActivityTimeline
                events={events}
                loading={eventsLoading}
                error={eventsError}
              />
            </div>
          ),
        };
      }
      return {
        value: spec.value,
        label: spec.label,
        count: spec.count,
        content: <SessionActivityTimeline engagements={ticket.engagements} />,
      };
    });
  }, [
    ticket,
    id,
    summarySections,
    criteriaError,
    savingCriterionIndex,
    optimisticChecks,
    events,
    eventsLoading,
    eventsError,
  ]);

  // Fresh server data is authoritative — drop any optimistic overlay so the
  // checkboxes reflect the canonical ticket body again.
  useEffect(() => {
    setOptimisticChecks({});
  }, [ticket]);
  const criteria = summarySections.acceptanceCriteria;
  const checkedCount = criteria.filter((c) => c.checked).length;
  const allChecked = criteria.length > 0 && checkedCount === criteria.length;
  const prevAllCheckedRef = useRef(allChecked);
  const initialSyncDoneRef = useRef(false);

  useEffect(() => {
    // Wait until the ticket payload has loaded before treating any state as a transition.
    // Without this guard, the initial empty-criteria render (allChecked === false) followed by
    // the post-fetch render (allChecked === true) reads as a "just became all-checked" event
    // and fires the glow on page load for already-complete tickets.
    if (!ticket) return;
    if (!initialSyncDoneRef.current) {
      prevAllCheckedRef.current = allChecked;
      initialSyncDoneRef.current = true;
      return;
    }
    if (allChecked && !prevAllCheckedRef.current) {
      setReviewGlowKey((n) => n + 1);
    }
    prevAllCheckedRef.current = allChecked;
  }, [allChecked, ticket]);

  if (loading) {
    return <LoadingState label="Loading ticket workspace…" />;
  }

  if (error || !ticket || !id) {
    return <ErrorState error={error || 'Ticket not found.'} onRetry={refetch} />;
  }

  const ticketSlug = ticket.slug;
  const progress = criteria.length > 0 ? { checked: checkedCount, total: criteria.length } : undefined;

  const transitions = ticket.availableVerbs ?? [];
  const primaryTransition = pickPrimaryVerb(ticket.next, transitions);
  const secondaryTransitions = pickSecondaryVerbs(transitions, primaryTransition);
  const overflowTransitions = transitions.filter(
    (a) =>
      a !== primaryTransition &&
      !secondaryTransitions.includes(a) &&
      !a.disabled &&
      a.targetStatus !== ticket.status,
  );

  async function handleDeleteTicket() {
    setDeleteLoading(true);
    try {
      await deleteTicket(id!);
      navigate(projectSlug ? `/projects/${projectSlug}` : '/tickets');
    } catch (err) {
      setTransitionError((err as Error).message);
      setDeleteLoading(false);
      setShowDeleteConfirm(false);
    }
  }

  async function runTransition(action: TicketTransitionAction, reason?: string): Promise<boolean> {
    setTransitionError(null);
    setTransitioning(action.command);

    try {
      const agent =
        action.command === 'start'
          ? resolveStartAgentOverride(
              startAgentOverride,
              ticket!.stageHandoff?.startDefaultAgentId ?? null,
            )
          : undefined;
      const result = await runTicketVerb(id!, action.command, { reason, agent });
      for (const message of dispatchVerbMessages(result)) {
        showToast(message, 'error');
      }
      setStartAgentOverride(null);
      refetch();
      refetchEvents();
      return true;
    } catch (mutationError) {
      setTransitionError((mutationError as Error).message);
      return false;
    } finally {
      setTransitioning(null);
    }
  }

  function handleTransitionClick(action: TicketTransitionAction) {
    if (transitionNeedsReason(action)) {
      setPendingTransition(action);
      return;
    }

    void runTransition(action);
  }

  async function toggleAcceptanceCriterion(index: number, checked: boolean) {
    setCriteriaError(null);
    setSavingCriterionIndex(index);
    // Flip optimistically so the checkbox responds instantly.
    setOptimisticChecks((prev) => ({ ...prev, [index]: checked }));

    try {
      const response = await fetch(
        `/api/tickets/${id}/acceptance-criteria/${index}`,
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

      // Keep the eventual refetch for consistency; it clears the overlay.
      refetch();
    } catch (mutationError) {
      // Revert this criterion's optimistic flip and surface the failure.
      setOptimisticChecks((prev) => {
        const next = { ...prev };
        delete next[index];
        return next;
      });
      const message = (mutationError as Error).message;
      setCriteriaError(message);
      showToast(message || 'Failed to update acceptance criterion', 'error');
    } finally {
      setSavingCriterionIndex(null);
    }
  }

  const overflowItems: OverflowMenuItem[] = [
    ...overflowTransitions.map<OverflowMenuItem>((action) => ({
      key: `transition-${action.command}`,
      label: action.label,
      onSelect: () => handleTransitionClick(action),
      disabled: transitioning === action.command,
    })),
    ...transitions
      .filter(
        (a) =>
          a.disabled ||
          a.targetStatus === ticket.status ||
          a === primaryTransition ||
          secondaryTransitions.includes(a),
      )
      .map<OverflowMenuItem>((action) => ({
        key: `transition-${action.command}`,
        label: action.label,
        disabled: true,
        disabledReason:
          action.targetStatus === ticket.status
            ? `Already ${ticket.status.replace(/_/g, ' ')}`
            : action.disabledReason ?? action.warning ?? action.description,
      })),
    {
      key: 'edit-ticket',
      label: 'Edit ticket source',
      icon: FilePenLine,
      href: ticketEditHref(id),
    },
    {
      key: 'edit-plan',
      label: 'Edit plan',
      icon: SendToBack,
      href: ticketEditHref(id, 'plan'),
    },
    {
      key: 'edit-scratchpad',
      label: 'Edit scratchpad',
      icon: NotebookPen,
      href: ticketEditHref(id, 'scratchpad'),
    },
    {
      key: 'delete',
      label: 'Delete ticket',
      icon: Trash2,
      destructive: true,
      onSelect: () => setShowDeleteConfirm(true),
    },
  ];

  const primaryIsReview = primaryTransition?.command === 'review';
  const offersStart = transitions.some((action) => action.command === 'start' && !action.disabled);

  return (
    <div className="space-y-5">
      <Toaster toast={toast} onDismiss={dismissToast} />
      <div className="sticky top-12 z-20 rounded-lg border border-border/60 bg-card/90 p-3 shadow-sm backdrop-blur">
        <div className="flex items-center gap-3">
          <TicketStatusPill
            id={ticket.id}
            slug={ticketSlug}
            projectSlug={projectSlug}
            status={ticket.status}
            title={ticket.title}
            availableVerbs={ticket.availableVerbs}
            progress={progress}
            startAgentOverride={startAgentOverride}
            startDefaultAgentId={ticket.stageHandoff?.startDefaultAgentId ?? null}
            onStartSuccess={() => setStartAgentOverride(null)}
            onChange={() => refetch()}
          />
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-lg font-semibold text-foreground" title={ticket.title}>
              {ticket.title}
            </h1>
            {(ticket.blocked || ticket.parked) && (
              <div className="mt-1 flex flex-wrap gap-2 text-xs">
                {ticket.blocked ? (
                  <span className="rounded border border-status-blocked-foreground/30 bg-status-blocked px-2 py-0.5 text-status-blocked-foreground">
                    Blocked: {ticket.blocked}
                  </span>
                ) : null}
                {ticket.parked ? (
                  <span className="rounded border border-status-archived-foreground/30 bg-status-archived px-2 py-0.5 text-status-archived-foreground">
                    Parked: {ticket.parked}
                  </span>
                ) : null}
              </div>
            )}
          </div>
          {unmetDeps.length > 0 && (
            <span
              className="shrink-0 whitespace-nowrap text-xs text-warning-foreground"
              title={`Unmet dependencies: ${unmetDeps.map((d) => d.title).join(', ')}`}
            >
              ⚠ {unmetDeps.length} unmet dep{unmetDeps.length === 1 ? '' : 's'}
            </span>
          )}
          <span className="flex shrink-0 items-center gap-2">
            {!ticket.workspace?.worktree && (
              <CreateWorktreeButton
                ticketId={ticket.id}
                defaultBranch={
                  projectSlug
                    ? `syntaur/${projectSlug}/${ticket.slug}`
                    : `syntaur/${ticket.slug}`
                }
                onCreated={() => refetch()}
              />
            )}
            {offersStart ? (
              <StartAgentPicker
                defaultAgentId={ticket.stageHandoff?.startDefaultAgentId ?? null}
                defaultAuto={ticket.stageHandoff?.startDefaultAuto ?? true}
                value={startAgentOverride}
                onChange={setStartAgentOverride}
                disabled={Boolean(transitioning)}
              />
            ) : null}
            {primaryTransition && (
              <button
                key={primaryIsReview ? `review-${reviewGlowKey}` : primaryTransition.command}
                type="button"
                title={primaryTransition.warning || primaryTransition.description}
                disabled={transitioning === primaryTransition.command || primaryTransition.disabled}
                onClick={() => handleTransitionClick(primaryTransition)}
                className={cn(
                  'shell-action disabled:cursor-not-allowed disabled:opacity-50',
                  primaryTransition.warning && 'border-warning-foreground/40',
                  primaryIsReview && reviewGlowKey > 0 && 'send-to-review-glow',
                )}
              >
                <span>
                  {transitioning === primaryTransition.command ? 'Working…' : primaryTransition.label}
                </span>
              </button>
            )}
            {ticket.stageHandoff ? (
              <StageHandoffControl
                ticketId={ticket.id}
                descriptor={ticket.stageHandoff}
                dispatch={stageDispatch}
              />
            ) : null}
            {secondaryTransitions.map((action) => (
              <button
                key={action.command}
                type="button"
                title={action.description}
                disabled={transitioning === action.command || action.disabled}
                onClick={() => handleTransitionClick(action)}
                className="rounded border border-border px-2 py-1 text-xs text-muted-foreground hover:border-foreground/40 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
              >
                {transitioning === action.command ? 'Working…' : action.label}
              </button>
            ))}
            <OverflowMenu items={overflowItems} align="end" />
          </span>
        </div>

        {transitionError ? (
          <p className="mt-4 rounded-md border border-error-foreground/30 bg-error px-4 py-3 text-sm text-error-foreground">
            {transitionError}
          </p>
        ) : null}

        {ticket.blocked ? (
          <div className="mt-4 rounded-md border border-warning-foreground/30 bg-warning px-4 py-3 text-sm text-warning-foreground">
            <strong>Blocked:</strong> {ticket.blocked}
          </div>
        ) : null}

        {ticket.parked ? (
          <div className="mt-4 rounded-md border border-warning-foreground/30 bg-warning px-4 py-3 text-sm text-warning-foreground">
            <strong>Parked:</strong> {ticket.parked}
          </div>
        ) : null}

        {ticket.next ? (
          <p className="mt-3 text-xs text-muted-foreground">
            <span className="font-medium text-foreground">Next:</span> {ticket.next}
          </p>
        ) : null}
      </div>

      {enrichedDeps.length > 0 && projectSlug && (
        <DependencyPanel
          projectSlug={projectSlug}
          dependencies={enrichedDeps}
          blocked={ticket.blocked}
          onTicketChange={() => refetch()}
        />
      )}

      {ticket.enrichedLinks && ticket.enrichedLinks.length > 0 && (
        <LinksPanel links={ticket.enrichedLinks} onTicketChange={() => refetch()} />
      )}

      {ticket.referencedBy && ticket.referencedBy.length > 0 && (
        <SectionCard
          title="Referenced by"
          description="Other tickets whose journal entries link to this one."
        >
          <ul className="space-y-2">
            {ticket.referencedBy.map((ref) => {
              const href = ticketPageHref(ref.sourceId);
              return (
                <li key={ref.sourceId} className="flex items-center gap-2 text-sm">
                  <Link to={href} className="text-foreground hover:text-primary">
                    {ref.sourceTitle}
                  </Link>
                  <span className="text-xs text-muted-foreground">
                    ({ref.mentions} mention{ref.mentions === 1 ? '' : 's'})
                  </span>
                  {ref.sourceProjectSlug === null ? (
                    <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] uppercase text-muted-foreground">
                      Standalone
                    </span>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </SectionCard>
      )}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_280px]">
        <div className="space-y-4">
          <ContentTabs
            value={tab}
            onValueChange={(value) => setSearchParams({ tab: value })}
            items={tabItems}
          />
        </div>

        <div className="min-w-0 space-y-5">
          <SectionCard title="Details">
            <dl className="space-y-3 text-sm">
              <DetailRow label="ID" value={ticket.id} copyable />
              <DetailRow label="Priority" value={ticket.priority} />
              {ticket.assignee && <DetailRow label="Assignee" value={ticket.assignee} />}
              {ticket.template && (
                <DetailNodeRow label="Template">
                  <TemplateChip template={ticket.template} compact />
                </DetailNodeRow>
              )}
              <DetailRow
                label="Updated"
                value={`${formatShortDateTime(ticket.updated)} · Created ${formatShortDate(ticket.created)}`}
              />
              {ticket.workspace.repository && (
                <DetailRow label="Repository" value={ticket.workspace.repository} copyable />
              )}
              {ticket.workspace.worktree && (
                <DetailRow label="Worktree" value={ticket.workspace.worktree} copyable />
              )}
              {ticket.workspace.branch && (
                <DetailRow label="Branch" value={ticket.workspace.branch} copyable />
              )}
              {ticket.workspace.parentBranch && (
                <DetailRow label="Parent branch" value={ticket.workspace.parentBranch} copyable />
              )}
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

      <TicketTransitionDialog
        open={pendingTransition !== null}
        action={pendingTransition}
        ticketTitle={ticket.title}
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
        title="Delete ticket?"
        description={`This will permanently delete "${ticket.title}" and all its files (plan, scratchpad, journal, and any legacy record files). This cannot be undone.`}
        confirmLabel="Delete Ticket"
        destructive
        loading={deleteLoading}
        onOpenChange={(open) => {
          if (!open) setShowDeleteConfirm(false);
        }}
        onConfirm={handleDeleteTicket}
      />
    </div>
  );
}

function DetailRow({ label, value, copyable }: { label: string; value: string; copyable?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="flex items-center gap-1.5 max-w-[60%] text-right text-foreground break-all">
        <span className="block min-w-0 truncate" title={value}>{value}</span>
        {copyable && value !== '\u2014' && <CopyButton value={value} />}
      </dd>
    </div>
  );
}

function DetailNodeRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="flex max-w-[60%] items-center justify-end gap-1.5 text-right text-foreground">
        {children}
      </dd>
    </div>
  );
}

