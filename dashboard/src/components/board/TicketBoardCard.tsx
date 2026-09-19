import { Link } from 'react-router-dom';
import { CopyButton } from '../CopyButton';
import { InlineTitleEditor } from '../InlineTitleEditor';
import { StatusBadge } from '../StatusBadge';
import { TemplateChip } from '../TemplateChip';
import { TicketStatusPill } from '../TicketStatusPill';
import { TicketMetrics } from '../ticket/TicketMetrics';
import { cn } from '../../lib/utils';
import { formatDate } from '../../lib/format';
import { ticketDetailHref } from '../../lib/ticketFilter';
import { useBodyClickNavigation } from '../../hooks/useBodyClickNavigation';
import type { TicketBoardItem, TicketTransitionAction } from '../../data/types';

export interface TicketBoardCardProps {
  ticket: TicketBoardItem;
  dragging?: boolean;
  transitioning?: boolean;
  onPillSelect?: (action: TicketTransitionAction) => void;
  onRenameTitle?: (newTitle: string) => Promise<void>;
}

export function TicketBoardCard({
  ticket,
  dragging,
  transitioning,
  onPillSelect,
  onRenameTitle,
}: TicketBoardCardProps) {
  const detailHref = ticketDetailHref(ticket);
  const inlineEditEnabled = Boolean(onPillSelect && onRenameTitle);
  const bodyNav = useBodyClickNavigation<HTMLDivElement>(detailHref);

  return (
    <div
      ref={inlineEditEnabled ? bodyNav.containerRef : undefined}
      className={cn(
        'vp-card rounded-lg border border-border/60 bg-background/85 p-3 shadow-sm',
        inlineEditEnabled && 'cursor-pointer',
      )}
      onMouseDown={inlineEditEnabled ? bodyNav.onMouseDown : undefined}
      onClick={inlineEditEnabled ? bodyNav.onClick : undefined}
      data-testid="ticket-board-card"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1 space-y-1">
          {inlineEditEnabled ? (
            <InlineTitleEditor
              title={ticket.title}
              detailHref={detailHref}
              onSave={onRenameTitle!}
              disabled={transitioning}
            />
          ) : (
            <Link to={detailHref} className="text-base font-semibold text-foreground hover:text-primary">
              {ticket.title}
            </Link>
          )}
          <p className="text-sm text-muted-foreground">{ticket.projectTitle ?? ticket.projectSlug ?? ''}</p>
          <p className="inline-flex items-center gap-1.5 font-mono text-xs text-muted-foreground/70" title={ticket.id}>
            {ticket.id.slice(0, 8)}
            <CopyButton value={ticket.id} />
          </p>
        </div>
        {inlineEditEnabled ? (
          <TicketStatusPill
            id={ticket.id}
            slug={ticket.slug}
            projectSlug={ticket.projectSlug}
            status={ticket.status}
            availableVerbs={ticket.availableVerbs}
            title={ticket.title}
            disabled={transitioning}
            className="max-w-[150px]"
            onSelectAction={onPillSelect}
          />
        ) : (
          <StatusBadge status={ticket.status} className="max-w-[150px]" />
        )}
      </div>

      {ticket.blocked ? (
        <p className="mt-3 rounded-md border border-warning-foreground/30 bg-warning px-3 py-2 text-sm text-warning-foreground">
          {ticket.blocked}
        </p>
      ) : null}
      {ticket.parked ? (
        <p className="mt-3 rounded-md border border-border/60 bg-muted px-3 py-2 text-sm text-muted-foreground">
          Parked: {ticket.parked}
        </p>
      ) : null}

      <div className="mt-3">
        <TicketMetrics metrics={ticket.metrics} variant="card" />
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        <TemplateChip template={ticket.template} />
        <span className="rounded-full border border-border/60 px-2.5 py-1 text-xs capitalize text-muted-foreground">
          {ticket.priority}
        </span>
        <span className="rounded-full border border-border/60 px-2.5 py-1 text-xs text-muted-foreground">
          {ticket.assignee ?? 'Unassigned'}
        </span>
        {ticket.depends_on.length > 0 ? (
          <span className="rounded-full border border-border/60 px-2.5 py-1 text-xs text-muted-foreground">
            {ticket.depends_on.length} {ticket.depends_on.length === 1 ? 'dependency' : 'dependencies'}
          </span>
        ) : null}
      </div>

      <div className="mt-4 flex items-center justify-between gap-3 text-xs uppercase tracking-[0.08em] text-muted-foreground">
        <span>{transitioning ? 'Updating' : dragging ? 'Dragging' : 'Source-first'}</span>
        <span>{formatDate(ticket.updated)}</span>
      </div>
    </div>
  );
}
