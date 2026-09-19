import { TemplateChip } from '../TemplateChip';
import { SectionCard } from '../SectionCard';
import { AgentSessionsSection } from './AgentSessionsSection';
import { TicketUsageSection } from '../TicketUsageSection';
import { formatShortDate, formatShortDateTime } from '../../lib/format';
import type { TicketDetail } from '../../hooks/useProjects';
import type { AgentSessionWithLiveness } from '../../types';
import { DetailNodeRow, DetailRow } from './TicketHeader';

export interface TicketRailProps {
  ticket: TicketDetail;
  sessions: AgentSessionWithLiveness[] | undefined;
  sessionsLoading: boolean;
  sessionsError: string | null;
  usageSummary: import('../../hooks/useProjects').TicketUsageResponse['summary'] | undefined;
  usageLoading: boolean;
  usageError: string | null;
  onSessionError: (error: Error) => void;
  onSessionNotice: (message: string) => void;
}

export function TicketRail({
  ticket,
  sessions,
  sessionsLoading,
  sessionsError,
  usageSummary,
  usageLoading,
  usageError,
  onSessionError,
  onSessionNotice,
}: TicketRailProps) {
  return (
    <div className="min-w-0 space-y-5">
      <SectionCard title="Details">
        <dl className="space-y-3 text-sm">
          <DetailRow label="ID" value={ticket.id} copyable />
          <DetailRow label="Priority" value={ticket.priority} />
          {ticket.assignee ? <DetailRow label="Assignee" value={ticket.assignee} /> : null}
          {ticket.template ? (
            <DetailNodeRow label="Template">
              <TemplateChip template={ticket.template} compact />
            </DetailNodeRow>
          ) : null}
          <DetailRow
            label="Updated"
            value={`${formatShortDateTime(ticket.updated)} · Created ${formatShortDate(ticket.created)}`}
          />
          {ticket.workspace.repository ? (
            <DetailRow label="Repository" value={ticket.workspace.repository} copyable />
          ) : null}
          {ticket.workspace.worktree ? (
            <DetailRow label="Worktree" value={ticket.workspace.worktree} copyable />
          ) : null}
          {ticket.workspace.branch ? (
            <DetailRow label="Branch" value={ticket.workspace.branch} copyable />
          ) : null}
          {ticket.workspace.parentBranch ? (
            <DetailRow label="Parent branch" value={ticket.workspace.parentBranch} copyable />
          ) : null}
        </dl>
      </SectionCard>

      <AgentSessionsSection
        sessions={sessions}
        loading={sessionsLoading}
        error={sessionsError}
        onError={onSessionError}
        onNotice={onSessionNotice}
      />

      <TicketUsageSection summary={usageSummary} loading={usageLoading} error={usageError} />
    </div>
  );
}
