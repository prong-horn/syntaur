import type { ReactNode } from 'react';
import { CopyButton } from '../CopyButton';
import { TicketStatusPill } from '../TicketStatusPill';
import { CreateWorktreeButton } from './CreateWorktreeButton';
import { StartAgentPicker } from '../StartAgentPicker';
import { StageHandoffControl } from '../StageHandoffControl';
import { OverflowMenu, type OverflowMenuItem } from '../OverflowMenu';
import { TicketMetrics } from './TicketMetrics';
import type { TicketDetail, TicketTransitionAction } from '../../hooks/useProjects';
import type { StageDispatchActions } from '../../hooks/useStageDispatch';
import { cn } from '../../lib/utils';

export interface TicketHeaderProps {
  ticket: TicketDetail;
  projectSlug: string | undefined;
  progress: { checked: number; total: number } | undefined;
  unmetDepsCount: number;
  unmetDepTitles: string;
  primaryTransition: TicketTransitionAction | null | undefined;
  secondaryTransitions: TicketTransitionAction[];
  overflowItems: OverflowMenuItem[];
  transitionError: string | null;
  transitioning: string | null;
  reviewGlowKey: number;
  startAgentOverride: string | null;
  onStartAgentOverrideChange: (value: string | null) => void;
  onStartSuccess: () => void;
  onTicketRefetch: () => void;
  onTransitionClick: (action: TicketTransitionAction) => void;
  stageDispatch: StageDispatchActions;
}

export function TicketHeader({
  ticket,
  projectSlug,
  progress,
  unmetDepsCount,
  unmetDepTitles,
  primaryTransition,
  secondaryTransitions,
  overflowItems,
  transitionError,
  transitioning,
  reviewGlowKey,
  startAgentOverride,
  onStartAgentOverrideChange,
  onStartSuccess,
  onTicketRefetch,
  onTransitionClick,
  stageDispatch,
}: TicketHeaderProps) {
  const offersStart = (ticket.availableVerbs ?? []).some(
    (action) => action.command === 'start' && !action.disabled,
  );
  const primaryIsReview = primaryTransition?.command === 'review';

  return (
    <div className="sticky top-12 z-20 rounded-lg border border-border/60 bg-card/90 p-3 shadow-sm backdrop-blur">
      <div className="flex flex-wrap items-start gap-3">
        <TicketStatusPill
          id={ticket.id}
          slug={ticket.slug}
          projectSlug={projectSlug}
          status={ticket.status}
          title={ticket.title}
          availableVerbs={ticket.availableVerbs}
          progress={progress}
          startAgentOverride={startAgentOverride}
          startDefaultAgentId={ticket.stageHandoff?.startDefaultAgentId ?? null}
          onStartSuccess={onStartSuccess}
          onChange={() => onTicketRefetch()}
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <h1 className="truncate text-lg font-semibold text-foreground" title={ticket.title}>
              {ticket.title}
            </h1>
            <TicketMetrics metrics={ticket.metrics} variant="header" />
          </div>
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
        {unmetDepsCount > 0 && (
          <span
            className="shrink-0 whitespace-nowrap text-xs text-warning-foreground"
            title={`Unmet dependencies: ${unmetDepTitles}`}
          >
            ⚠ {unmetDepsCount} unmet dep{unmetDepsCount === 1 ? '' : 's'}
          </span>
        )}
        <span className="flex w-full min-w-0 flex-wrap items-center gap-2 max-lg:order-last lg:ml-auto lg:w-auto lg:shrink-0 lg:justify-end">
          {!ticket.workspace?.worktree && (
            <CreateWorktreeButton
              ticketId={ticket.id}
              projectSlug={projectSlug}
              defaultBranch={
                projectSlug ? `syntaur/${projectSlug}/${ticket.slug}` : `syntaur/${ticket.slug}`
              }
              onCreated={() => onTicketRefetch()}
            />
          )}
          {offersStart ? (
            <StartAgentPicker
              defaultAgentId={ticket.stageHandoff?.startDefaultAgentId ?? null}
              defaultAuto={ticket.stageHandoff?.startDefaultAuto ?? true}
              value={startAgentOverride}
              onChange={onStartAgentOverrideChange}
              disabled={Boolean(transitioning)}
            />
          ) : null}
          {primaryTransition && (
            <button
              key={primaryIsReview ? `review-${reviewGlowKey}` : primaryTransition.command}
              type="button"
              title={primaryTransition.warning || primaryTransition.description}
              disabled={transitioning === primaryTransition.command || primaryTransition.disabled}
              onClick={() => onTransitionClick(primaryTransition)}
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
              onClick={() => onTransitionClick(action)}
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
  );
}

export function DetailRow({
  label,
  value,
  copyable,
}: {
  label: string;
  value: string;
  copyable?: boolean;
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="flex max-w-[60%] items-center gap-1.5 break-all text-right text-foreground">
        <span className="block min-w-0 truncate" title={value}>
          {value}
        </span>
        {copyable && value !== '\u2014' ? <CopyButton value={value} /> : null}
      </dd>
    </div>
  );
}

export function DetailNodeRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="flex max-w-[60%] items-center justify-end gap-1.5 text-right text-foreground">
        {children}
      </dd>
    </div>
  );
}
