import { Activity } from 'lucide-react';
import { CopyButton } from './CopyButton';
import { StatusBadge } from './StatusBadge';
import { SectionCard } from './SectionCard';
import { EmptyState } from './EmptyState';
import { formatDateTime } from '../lib/format';
import type { AgentSession } from '../types';

interface AgentSessionsSectionProps {
  sessions: AgentSession[] | undefined;
  loading: boolean;
  error: string | null;
}

export function AgentSessionsSection({ sessions, loading, error }: AgentSessionsSectionProps) {
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
              </span>
            </span>
            <span className="flex items-center gap-2">
              <StatusBadge status={session.status} />
              <span className="text-xs text-muted-foreground">{formatDateTime(session.started)}</span>
            </span>
          </div>
        ))}
      </div>
    </SectionCard>
  );
}
