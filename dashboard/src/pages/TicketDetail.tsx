import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  Archive,
  ArchiveRestore,
  ArrowUpRight,
  ExternalLink,
  FilePenLine,
  Hammer,
  NotebookPen,
  SendToBack,
  Trash2,
} from 'lucide-react';
import { CopyButton } from '../components/CopyButton';
import { useTicket, useProject, useTicketSessions, useTicketUsage, type TicketTransitionAction, type ExternalIdInfo } from '../hooks/useProjects';
import { ticketEditHref, ticketPageHref } from '../lib/routes';
import { useTicketEvents } from '../hooks/useTicketEvents';
import { useStatusConfig, useWorkflows } from '../hooks/useStatusConfig';
import { formatShortDate, formatShortDateTime } from '../lib/format';
import { LoadingState } from '../components/LoadingState';
import { ErrorState } from '../components/ErrorState';
import { StatusBadge } from '../components/StatusBadge';
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
  runTicketTransition,
  overrideTicketStatus,
  transitionNeedsReason,
} from '../lib/tickets';
import { splitTicketSummary } from '../lib/acceptanceCriteria';
import { DependencyPanel } from '../components/DependencyPanel';
import { FactsPanel } from '../components/FactsPanel';
import { LinksPanel } from '../components/LinksPanel';
import { CommentsThread } from '../components/CommentsThread';
import { ActivityTimeline } from '../components/ActivityTimeline';
import { SessionActivityTimeline } from '../components/SessionActivityTimeline';
import { ChatTab } from '../components/chat/ChatTab';
import { useHotkey, useHotkeyScope } from '../hotkeys';
import { useHashScroll } from '../hooks/useHashScroll';
import { cn } from '../lib/utils';
import { useToast, Toaster } from '../components/Toast';

const TRANSITION_PRECEDENCE = ['review', 'complete', 'shape', 'plan-ready', 'implement', 'unblock', 'start', 'block', 'fail', 'reopen'] as const;

/** The Workflow detail row — a dropdown to bind a ticket to a workflow
 * (or inherit the resolved binding). */
function WorkflowSelectRow({
  projectSlug: _projectSlug,
  ticketId,
  workflow,
  workflowLabel,
  onChanged,
}: {
  projectSlug: string;
  ticketId: string;
  workflow: string | null;
  workflowLabel: string;
  onChanged: () => void;
}) {
  const { workflows } = useWorkflows();
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function change(value: string) {
    setSaving(true);
    setErr(null);
    try {
      const res = await fetch(
        `/api/tickets/${encodeURIComponent(ticketId)}/workflow`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ workflow: value === '' ? null : value }),
        },
      );
      if (!res.ok) {
        const e = await res.json().catch(() => null);
        throw new Error(e?.error ?? `HTTP ${res.status}`);
      }
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed to set workflow');
    } finally {
      setSaving(false);
    }
  }

  return (
    <DetailNodeRow label="Workflow">
      <div className="flex flex-col gap-1">
        <select
          className="rounded-md border border-border/60 bg-background px-2 py-1 text-xs"
          value={workflow ?? ''}
          disabled={saving}
          onChange={(e) => void change(e.target.value)}
        >
          <option value="">Inherit ({workflowLabel})</option>
          {workflows.map((w) => (
            <option key={w.id} value={w.id}>
              {w.label}
            </option>
          ))}
        </select>
        {err && <span className="text-[11px] text-error-foreground">{err}</span>}
      </div>
    </DetailNodeRow>
  );
}

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
  const tab = searchParams.get('tab') ?? 'summary';
  // Honor `#section` deep-links from the command palette once the pane renders.
  useHashScroll(tab);
  const statusConfig = useStatusConfig();
  const { data: ticket, loading, error, refetch } = useTicket(id);
  const projectSlug = ticket?.projectSlug ?? undefined;
  const { data: project } = useProject(projectSlug);
  const { data: sessionsData, loading: sessionsLoading, error: sessionsError } = useTicketSessions(id);
  const { data: usageData, loading: usageLoading, error: usageError } = useTicketUsage(id);
  const eventsUrl = id ? `/api/tickets/${id}/events` : null;
  const {
    events,
    loading: eventsLoading,
    error: eventsError,
    refetch: refetchEvents,
  } = useTicketEvents(eventsUrl);

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
    keys: 'h',
    scope: 'ticket',
    description: 'Append handoff',
    handler: () => id && navigate(ticketEditHref(id, 'handoff')),
  });
  useHotkey({
    keys: 'd',
    scope: 'ticket',
    description: 'Append decision record',
    handler: () => id && navigate(ticketEditHref(id, 'decision-record')),
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

  const transitions = ticket.availableTransitions ?? [];
  // Exclude same-target transitions: the backend currently returns every command as enabled
  // even when the targetStatus equals the current status, which would produce a meaningless
  // idempotent primary action. Filter those out for the primary slot; they still surface in
  // the overflow menu as disabled with "Already in this status".
  const enabledTransitions = transitions.filter(
    (a) => !a.disabled && a.targetStatus !== ticket.status,
  );
  const primaryTransition =
    TRANSITION_PRECEDENCE.map((cmd) => enabledTransitions.find((a) => a.command === cmd)).find(Boolean) ??
    enabledTransitions[0] ??
    null;

  async function handleStatusOverride(status: string) {
    setTransitionError(null);
    try {
      await overrideTicketStatus(id!, status);
      refetch();
      refetchEvents();
    } catch (err) {
      setTransitionError((err as Error).message);
    }
  }

  async function handleArchiveTicket(archived: boolean) {
    setTransitionError(null);
    try {
      const response = await fetch(
        `/api/tickets/${id}/${archived ? 'archive' : 'unarchive'}`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' } },
      );
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        throw new Error(payload?.error || `HTTP ${response.status}`);
      }
      refetch();
      refetchEvents();
      showToast(archived ? 'Ticket archived' : 'Ticket restored', 'success');
    } catch (err) {
      setTransitionError((err as Error).message);
    }
  }

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
      await runTicketTransition(id!, action, reason);
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
    ...enabledTransitions
      .filter((a) => a !== primaryTransition)
      .map<OverflowMenuItem>((action) => ({
        key: `transition-${action.command}`,
        label: action.label,
        onSelect: () => handleTransitionClick(action),
        disabled: transitioning === action.command,
      })),
    ...transitions
      .filter((a) => a.disabled || a.targetStatus === ticket.status)
      .map<OverflowMenuItem>((action) => ({
        key: `transition-${action.command}`,
        label: action.label,
        disabled: true,
        disabledReason:
          action.targetStatus === ticket.status
            ? `Already ${ticket.status.replace(/_/g, ' ')}`
            : action.disabledReason ?? action.warning ?? action.description,
      })),
    ...statusConfig.statuses.map<OverflowMenuItem>((s) => ({
      key: `override-${s.id}`,
      label: `Override → ${s.label}`,
      onSelect: () => handleStatusOverride(s.id),
      disabled: s.id === ticket.status,
      disabledReason: s.id === ticket.status ? 'Already in this status' : undefined,
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
      key: 'append-handoff',
      label: 'Append handoff',
      icon: ArrowUpRight,
      href: ticketEditHref(id, 'handoff'),
    },
    {
      key: 'append-decision',
      label: 'Append decision',
      icon: Hammer,
      href: ticketEditHref(id, 'decision-record'),
    },
    {
      key: ticket.archived ? 'unarchive' : 'archive',
      label: ticket.archived ? 'Restore ticket' : 'Archive ticket',
      icon: ticket.archived ? ArchiveRestore : Archive,
      onSelect: () => handleArchiveTicket(!ticket.archived),
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
            availableTransitions={ticket.availableTransitions}
            progress={progress}
            onChange={() => refetch()}
          />
          <h1
            className="min-w-0 flex-1 truncate text-lg font-semibold text-foreground"
            title={ticket.title}
          >
            {ticket.title}
          </h1>
          {unmetDeps.length > 0 && (
            <span
              className="shrink-0 whitespace-nowrap text-xs text-warning-foreground"
              title={`Unmet dependencies: ${unmetDeps.map((d) => d.title).join(', ')}`}
            >
              ⚠ {unmetDeps.length} unmet dep{unmetDeps.length === 1 ? '' : 's'}
            </span>
          )}
          <span className="flex shrink-0 items-center gap-2">
            {!ticket.workspace?.worktreePath && (
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
            {primaryTransition && (
              <button
                key={primaryIsReview ? `review-${reviewGlowKey}` : primaryTransition.command}
                type="button"
                title={primaryTransition.warning || primaryTransition.description}
                disabled={transitioning === primaryTransition.command}
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
            <OverflowMenu items={overflowItems} align="end" />
          </span>
        </div>

        {transitionError ? (
          <p className="mt-4 rounded-md border border-error-foreground/30 bg-error px-4 py-3 text-sm text-error-foreground">
            {transitionError}
          </p>
        ) : null}

        {ticket.blockedReason ? (
          <div className="mt-4 rounded-md border border-warning-foreground/30 bg-warning px-4 py-3 text-sm text-warning-foreground">
            <strong>Blocked reason:</strong> {ticket.blockedReason}
          </div>
        ) : null}

        {/* Pin divergence: the always-visible "would otherwise be Y" (v3) */}
        {ticket.override && ticket.derived &&
          ticket.derived.derivedStatus !== ticket.status ? (
          <div className="mt-4 rounded-md border border-warning-foreground/30 bg-warning px-4 py-3 text-sm text-warning-foreground">
            <strong>Pinned to {ticket.status}</strong> by {ticket.override.source}
            {ticket.override.reason ? <> — “{ticket.override.reason}”</> : null}
            {' · '}would otherwise be <strong>{ticket.derived.derivedStatus}</strong>
          </div>
        ) : null}

        {/* Next action from the phase ladder */}
        {ticket.derived?.nextAction ? (
          <p className="mt-3 text-xs text-muted-foreground">
            <span className="font-medium text-foreground">Next:</span>{' '}
            {ticket.derived.nextAction}
          </p>
        ) : null}
      </div>

      {enrichedDeps.length > 0 && projectSlug && (
        <DependencyPanel
          projectSlug={projectSlug}
          dependencies={enrichedDeps}
          blockedReason={ticket.blockedReason}
          onTicketChange={() => refetch()}
        />
      )}

      {ticket.enrichedLinks && ticket.enrichedLinks.length > 0 && (
        <LinksPanel links={ticket.enrichedLinks} onTicketChange={() => refetch()} />
      )}

      {ticket.referencedBy && ticket.referencedBy.length > 0 && (
        <SectionCard
          title="Referenced by"
          description="Other tickets whose progress, comments, or handoffs link to this one."
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
            items={[
              {
                value: 'summary',
                label: 'Summary',
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
              },
              {
                // Phase 2 keeps `summary` as the default tab; §5.7's "arguably
                // the new default" is left for Brennen to call.
                value: 'chat',
                label: 'Chat',
                content: <ChatTab ticketId={ticket.id} />,
              },
              {
                value: 'plan',
                label: 'Plan',
                count: ticket.plan ? 1 : 0,
                content: ticket.plan ? (
                  <div className="space-y-5">
                    <SectionCard
                      title="Plan"
                      description="Shows plan.md only. Versioned plans (plan-v2.md, ...) are not yet rendered here — open them from the filesystem."
                      actions={
                        <Link className="shell-action" to={ticketEditHref(id, 'plan')}>
                          <NotebookPen className="h-4 w-4" />
                          <span>Edit Plan</span>
                        </Link>
                      }
                    >
                      <div className="mb-4">
                        <StatusBadge status={ticket.plan.status} />
                      </div>
                      <MarkdownRenderer content={ticket.plan.body} emptyState="No plan content yet." />
                    </SectionCard>
                  </div>
                ) : (
                  <EmptyState
                    title="No plan yet"
                    description="Plan files are optional and versioned. Run /plan-ticket to create plan.md (or plan-v2.md, ...)."
                  />
                ),
              },
              {
                value: 'scratchpad',
                label: 'Scratchpad',
                count: ticket.scratchpad ? 1 : 0,
                content: ticket.scratchpad ? (
                  <SectionCard
                    title="Scratchpad"
                    actions={
                      <Link className="shell-action" to={ticketEditHref(id, 'scratchpad')}>
                        <NotebookPen className="h-4 w-4" />
                        <span>Edit Scratchpad</span>
                      </Link>
                    }
                  >
                    <MarkdownRenderer content={ticket.scratchpad.body} emptyState="Scratchpad is empty." />
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
                count: ticket.handoff?.handoffCount ?? 0,
                content: (
                  <div className="space-y-5">
                    {ticket.handoff ? (
                      <SectionCard>
                        <MarkdownRenderer content={ticket.handoff.body} emptyState="No handoff history yet." />
                      </SectionCard>
                    ) : (
                      <EmptyState
                        title="No handoff log yet"
                        description="Handoffs appear here when an agent runs /complete-ticket or you append one manually."
                      />
                    )}
                  </div>
                ),
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
                        description="Reverse-chronological log of work done on this ticket. Agents append entries via progress.md."
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
                    {ticket.comments && ticket.comments.entries.length > 0 ? (
                      <CommentsThread
                        ticketId={id}
                        entries={ticket.comments.entries}
                      />
                    ) : (
                      <EmptyState
                        title="No comments yet"
                        description="Comments appear here when agents or humans post via `syntaur comment` or the dashboard."
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
              {
                value: 'activity',
                label: 'Activity',
                count: events.length,
                content: (
                  <div className="space-y-5">
                    <FactsPanel
                      customFacts={ticket.derived?.customFacts}
                      attestations={ticket.derived?.attestations}
                    />
                    <ActivityTimeline
                      events={events}
                      loading={eventsLoading}
                      error={eventsError}
                    />
                  </div>
                ),
              },
              {
                value: 'session-activity',
                label: 'Session Activity',
                count: ticket.engagements.length,
                content: (
                  <SessionActivityTimeline
                    engagements={ticket.engagements}
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
              {ticket.template && (
                <DetailNodeRow label="Type">
                  <TemplateChip template={ticket.template} compact />
                </DetailNodeRow>
              )}
              {ticket.projectSlug ? (
                <WorkflowSelectRow
                  projectSlug={ticket.projectSlug}
                  ticketId={id}
                  workflow={ticket.workflow}
                  workflowLabel={ticket.workflowLabel}
                  onChanged={refetch}
                />
              ) : (
                <DetailRow label="Workflow" value={ticket.workflowLabel} />
              )}
              {ticket.phase && ticket.phase !== ticket.status && (
                <DetailRow label="Phase" value={ticket.phase} />
              )}
              {ticket.disposition && ticket.disposition !== 'active' && (
                <DetailNodeRow label="Disposition">
                  <span
                    className="rounded-full border border-warning-foreground/40 px-2 py-0.5 text-[11px] text-warning-foreground"
                    title="Disposition dimension — orthogonal to phase"
                  >
                    {ticket.disposition}
                  </span>
                </DetailNodeRow>
              )}
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
        description={`This will permanently delete "${ticket.title}" and all its files (plan, scratchpad, handoff, decision record). This cannot be undone.`}
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
