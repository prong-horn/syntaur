import { Activity } from 'lucide-react';
import { CopyButton } from './CopyButton';
import { CopyLaunchCommandButton } from './CopyLaunchCommandButton';
import { StatusBadge } from './StatusBadge';
import { SectionCard } from './SectionCard';
import { EmptyState } from './EmptyState';
import { SessionActionButtons } from './SessionActionButtons';
import { formatDateTime } from '../lib/format';
import type { AgentSessionWithLiveness } from '../types';

interface AgentSessionsSectionProps {
  sessions: AgentSessionWithLiveness[] | undefined;
  loading: boolean;
  error: string | null;
  /** Surfaces copy-launch-command failures (e.g. to a toast). */
  onError?: (error: Error) => void;
  /** Surfaces a non-fatal notice after a copy (e.g. a fallback-cwd warning). */
  onNotice?: (message: string) => void;
}

/**
 * Per-assignment list of agent sessions, rendered on assignment detail pages.
 *
 * Mirrors the per-row affordances of the standalone /sessions page —
 * Resume / Fork / Mark-stopped — by mounting `<SessionActionButtons>` on
 * each row. Mark-stopped is fire-and-forget: PATCH is sent, then the
 * websocket `agent-sessions-updated` broadcast (subscribed to by
 * useAgentSessions / useProjects) refreshes the data.
 */
async function patchMarkStopped(sessionId: string): Promise<void> {
  await fetch(`/api/agent-sessions/${encodeURIComponent(sessionId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'stopped' }),
  });
}

export function AgentSessionsSection({ sessions, loading, error, onError, onNotice }: AgentSessionsSectionProps) {
  if (loading && !sessions) return null;

  if (error && !sessions) {
    return (
      <SectionCard title="Agent Sessions">
        <EmptyState title="Couldn't load sessions" description={error} />
      </SectionCard>
    );
  }

  if (!sessions || sessions.length === 0) {
    return (
      <SectionCard title="Agent Sessions">
        <EmptyState
          title="No agent sessions yet"
          description="Sessions appear here when an agent registers one via /grab-assignment or syntaur track-session."
        />
      </SectionCard>
    );
  }

  return (
    <SectionCard title="Agent Sessions">
      <div className="space-y-2">
        {sessions.map((session) => (
          <div key={session.sessionId} className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
            <span className="flex items-center gap-1.5">
              <Activity className="h-3 w-3 shrink-0 text-muted-foreground" />
              <span className="font-medium text-foreground">{session.agent}</span>
              <span
                className="inline-flex items-center gap-1.5 font-mono text-xs text-muted-foreground"
                title={session.sessionId}
              >
                {session.sessionId.slice(0, 8)}
                <CopyButton value={session.sessionId} />
                <CopyLaunchCommandButton
                  sessionId={session.sessionId}
                  disabled={!session.resumeSupported}
                  disabledReason="Resume not supported for this agent"
                  onError={onError}
                  onNotice={onNotice}
                />
              </span>
            </span>
            <span className="flex items-center gap-2">
              <StatusBadge status={session.status} />
              <span className="text-xs text-muted-foreground">{formatDateTime(session.started)}</span>
            </span>
            <SessionActionButtons session={session} onMarkStopped={patchMarkStopped} />
          </div>
        ))}
      </div>
    </SectionCard>
  );
}
