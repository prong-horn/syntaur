import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { FilePenLine, NotebookPen, SendToBack, Trash2 } from 'lucide-react';
import { DocumentEditorPage } from '../components/DocumentEditorPage';
import { DependencyPanel } from '../components/DependencyPanel';
import { LinksPanel } from '../components/LinksPanel';
import { SectionCard } from '../components/SectionCard';
import { LoadingState } from '../components/LoadingState';
import { ErrorState } from '../components/ErrorState';
import { Toaster, useToast } from '../components/Toast';
import { TicketDialogs } from '../components/ticket/TicketDialogs';
import { TicketHeader } from '../components/ticket/TicketHeader';
import { TicketRail } from '../components/ticket/TicketRail';
import { TicketTabsBody } from '../components/ticket/TicketTabsBody';
import {
  resolveTicketBodyEditor,
  ticketEditQueryHref,
  ticketFileEditQueryHref,
} from '../components/ticket/ticketEditorRoutes';
import { patchAcceptanceCriterion } from '../data/ticketResources';
import {
  useProject,
  useTicket,
  useTicketSessions,
  useTicketUsage,
  type TicketTransitionAction,
} from '../hooks/useProjects';
import { useTicketEvents } from '../hooks/useTicketEvents';
import { useStageDispatch } from '../hooks/useStageDispatch';
import { useHashScroll } from '../hooks/useHashScroll';
import { splitTicketSummary } from '../lib/acceptanceCriteria';
import { ticketPageHref } from '../lib/routes';
import {
  deleteTicket,
  dispatchVerbMessages,
  runTicketVerb,
  transitionNeedsReason,
} from '../lib/tickets';
import { resolveStartAgentOverride } from '../components/StartAgentPicker';
import { pickPrimaryVerb, pickSecondaryVerbs } from '../lib/verbActions';
import type { OverflowMenuItem } from '../components/OverflowMenu';

/** Canonical ticket workspace at `/t/:id` (SV-12 Task 4). */
export function TicketPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { toast, showToast, dismissToast } = useToast();
  const [transitionError, setTransitionError] = useState<string | null>(null);
  const [transitioning, setTransitioning] = useState<string | null>(null);
  const [pendingTransition, setPendingTransition] = useState<TicketTransitionAction | null>(null);
  const [criteriaError, setCriteriaError] = useState<string | null>(null);
  const [savingCriterionIndex, setSavingCriterionIndex] = useState<number | null>(null);
  const [optimisticChecks, setOptimisticChecks] = useState<Record<number, boolean>>({});
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [reviewGlowKey, setReviewGlowKey] = useState(0);
  const [startAgentOverride, setStartAgentOverride] = useState<string | null>(null);

  const tab = searchParams.get('tab') ?? 'summary';
  const editingTicket = searchParams.get('edit') === 'ticket';
  const editingFile = searchParams.get('edit') === '1';

  useHashScroll(tab);
  const { data: ticket, loading, error, refetch } = useTicket(id);
  // Legacy plan/notes editor links resolve against the current manifest. The
  // filename is never assumed, and missing/read-only roles return to Journal.
  useEffect(() => {
    const legacyRole = searchParams.get('edit');
    if (!ticket || (legacyRole !== 'plan' && legacyRole !== 'scratchpad')) return;
    const file = ticket.templateBlock.files.find((candidate) =>
      legacyRole === 'plan' ? candidate.role === 'plan' :
        (candidate.role === 'notes' || candidate.role === 'scratchpad'));
    const next = new URLSearchParams(searchParams);
    next.delete('edit');
    if (file?.exists && file.writer !== 'cli') {
      next.set('tab', `file:${file.path}`);
      next.set('edit', '1');
    } else {
      next.set('tab', 'journal');
      next.set('notice', `${legacyRole}-editor-unavailable`);
    }
    setSearchParams(next, { replace: true });
  }, [ticket, searchParams, setSearchParams]);
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

  const summarySections = useMemo(
    () => (ticket ? splitTicketSummary(ticket.body) : { acceptanceCriteria: [], summaryBody: '' }),
    [ticket],
  );

  useEffect(() => {
    setOptimisticChecks({});
  }, [ticket]);

  const criteria = summarySections.acceptanceCriteria;
  const checkedCount = criteria.filter((c) => c.checked).length;
  const allChecked = criteria.length > 0 && checkedCount === criteria.length;
  const prevAllCheckedRef = useRef(allChecked);
  const initialSyncDoneRef = useRef(false);

  useEffect(() => {
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

  if (editingTicket) {
    const spec = resolveTicketBodyEditor(id);
    return (
      <DocumentEditorPage
        loadUrl={spec.loadUrl}
        saveUrl={spec.saveUrl}
        redirectTo={spec.redirectTo}
        title={spec.title}
        description={spec.description}
        documentType={spec.documentType}
        helpTitle={spec.helpTitle}
        helpBody={spec.helpBody}
      />
    );
  }

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
      navigate(projectSlug ? `/board?project=${encodeURIComponent(projectSlug)}` : '/board');
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
    setOptimisticChecks((prev) => ({ ...prev, [index]: checked }));
    try {
      await patchAcceptanceCriterion(id!, index, checked);
      refetch();
    } catch (mutationError) {
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
      href: ticketEditQueryHref(id),
    },
    ...ticket.templateBlock.files.filter((file) =>
      file.writer !== 'cli' && file.exists &&
      (file.role === 'plan' || file.role === 'notes' || file.role === 'scratchpad'),
    ).map<OverflowMenuItem>((file) => ({
      key: `edit-${file.path}`,
      label: file.role === 'plan' ? 'Edit plan' : 'Edit notes',
      icon: file.role === 'plan' ? SendToBack : NotebookPen,
      href: ticketFileEditQueryHref(id, file.path),
    })),
    {
      key: 'delete',
      label: 'Delete ticket',
      icon: Trash2,
      destructive: true,
      onSelect: () => setShowDeleteConfirm(true),
    },
  ];

  return (
    <div className="min-w-0 space-y-5">
      <Toaster toast={toast} onDismiss={dismissToast} />
      {searchParams.get('notice')?.endsWith('-editor-unavailable') ? (
        <p role="status" className="rounded-md border border-border bg-muted/40 px-4 py-3 text-sm">
          This ticket has no editable file for that older link. Its current Journal is shown below.
        </p>
      ) : null}
      <TicketHeader
        ticket={ticket}
        projectSlug={projectSlug}
        progress={progress}
        unmetDepsCount={unmetDeps.length}
        unmetDepTitles={unmetDeps.map((d) => d.title).join(', ')}
        primaryTransition={primaryTransition}
        secondaryTransitions={secondaryTransitions}
        overflowItems={overflowItems}
        transitionError={transitionError}
        transitioning={transitioning}
        reviewGlowKey={reviewGlowKey}
        startAgentOverride={startAgentOverride}
        onStartAgentOverrideChange={setStartAgentOverride}
        onStartSuccess={() => setStartAgentOverride(null)}
        onTicketRefetch={refetch}
        onTransitionClick={handleTransitionClick}
        stageDispatch={stageDispatch}
      />

      {enrichedDeps.length > 0 && projectSlug ? (
        <DependencyPanel
          projectSlug={projectSlug}
          dependencies={enrichedDeps}
          blocked={ticket.blocked}
          onTicketChange={() => refetch()}
        />
      ) : null}

      {ticket.enrichedLinks && ticket.enrichedLinks.length > 0 ? (
        <LinksPanel links={ticket.enrichedLinks} onTicketChange={() => refetch()} />
      ) : null}

      {ticket.referencedBy && ticket.referencedBy.length > 0 ? (
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
      ) : null}

      <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1fr)_280px]">
        <TicketTabsBody
          ticket={ticket}
          ticketId={id}
          tab={tab}
          editingFile={editingFile}
          onTabChange={(value) => {
            const next = new URLSearchParams(searchParams);
            next.set('tab', value);
            next.delete('edit');
            setSearchParams(next);
          }}
          summarySections={summarySections}
          criteriaError={criteriaError}
          savingCriterionIndex={savingCriterionIndex}
          optimisticChecks={optimisticChecks}
          onToggleCriterion={toggleAcceptanceCriterion}
          events={events}
          eventsLoading={eventsLoading}
          eventsError={eventsError}
          onTicketRefetch={refetch}
        />

        <TicketRail
          ticket={ticket}
          sessions={sessionsData?.sessions}
          sessionsLoading={sessionsLoading}
          sessionsError={sessionsError}
          usageSummary={usageData?.summary}
          usageLoading={usageLoading}
          usageError={usageError}
          onSessionError={(e) => showToast(e.message, 'error')}
          onSessionNotice={(m) => showToast(m, 'success')}
        />
      </div>

      <TicketDialogs
        ticketTitle={ticket.title}
        pendingTransition={pendingTransition}
        transitioning={transitioning}
        onPendingOpenChange={(open) => {
          if (!open) setPendingTransition(null);
        }}
        onConfirmTransition={async (reason) => {
          if (!pendingTransition) return;
          const action = pendingTransition;
          const succeeded = await runTransition(action, reason);
          if (succeeded) setPendingTransition(null);
        }}
        showDeleteConfirm={showDeleteConfirm}
        deleteLoading={deleteLoading}
        onDeleteOpenChange={(open) => {
          if (!open) setShowDeleteConfirm(false);
        }}
        onConfirmDelete={handleDeleteTicket}
      />
    </div>
  );
}

/** @deprecated Import {@link TicketPage} — kept until Task 6 rewires routes. */
export const TicketDetail = TicketPage;
