import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { AgentSession } from '../types';
import { useWorkspacePrefix } from '../hooks/useProjects';
import { formatRelativeTime } from '../lib/format';
import { CopyButton } from './CopyButton';
import { DIALOG_COPY } from '../lib/overviewCopy';

interface RecentSessionsRailProps {
  sessions: AgentSession[];
}

export function RecentSessionsRail({ sessions }: RecentSessionsRailProps) {
  return (
    <aside
      aria-labelledby="overview-sessions-title"
      className="rounded-xl border border-border/60 bg-background/60 shadow-sm"
    >
      <header className="border-b border-border/40 px-4 py-3">
        <h3 id="overview-sessions-title" className="text-sm font-semibold text-foreground">
          Recent Sessions
        </h3>
      </header>
      {sessions.length === 0 ? (
        <div className="px-4 py-6 text-sm">
          <p className="font-medium text-foreground">{DIALOG_COPY.recentSessionsEmptyTitle}</p>
          <p className="mt-1 text-muted-foreground">{DIALOG_COPY.recentSessionsEmptyHint}</p>
        </div>
      ) : (
        <ul className="divide-y divide-border/40">
          {sessions.map((session) => (
            <li key={session.sessionId}>
              <SessionRow session={session} />
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}

interface SessionRowProps {
  session: AgentSession;
}

function SessionRow({ session }: SessionRowProps) {
  const prefix = useWorkspacePrefix();
  const [fallback, setFallback] = useState(false);

  const linkHref = sessionLink(session, prefix);
  const linkLabel = sessionLinkLabel(session);
  const pathEmpty = !session.path;

  return (
    <div className="flex items-start gap-3 px-4 py-3">
      <div className="min-w-0 flex-1">
        <Link
          to={linkHref}
          className="block text-sm font-medium text-foreground hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm"
        >
          {session.agent}
        </Link>
        <p className="text-xs text-muted-foreground">
          {linkLabel} · {formatRelativeTime(session.started)}
        </p>
        {fallback && session.path ? (
          <div className="mt-1 space-y-0.5">
            <code className="block w-full select-all rounded bg-muted/40 px-1.5 py-0.5 text-xs text-foreground">
              {session.path}
            </code>
            <p className="text-[10px] text-muted-foreground">{DIALOG_COPY.recentSessionsCopyFallbackHint}</p>
          </div>
        ) : null}
      </div>
      <CopyButton
        value={session.path}
        label={DIALOG_COPY.recentSessionsCopyPathLabel}
        disabled={pathEmpty}
        disabledReason={DIALOG_COPY.recentSessionsCopyPathDisabled}
        onError={() => setFallback(true)}
      />
    </div>
  );
}

function sessionLink(session: AgentSession, prefix: string): string {
  if (session.projectSlug && session.assignmentSlug) {
    return `${prefix}/projects/${session.projectSlug}/assignments/${session.assignmentSlug}`;
  }
  if (!session.projectSlug && session.assignmentSlug) {
    // Standalone assignments — no workspace prefix variant.
    return `/agent-sessions`;
  }
  return `/agent-sessions`;
}

function sessionLinkLabel(session: AgentSession): string {
  if (session.assignmentSlug && session.projectSlug) {
    return `${session.projectSlug}/${session.assignmentSlug}`;
  }
  if (session.assignmentSlug) {
    return `standalone/${session.assignmentSlug}`;
  }
  return 'standalone';
}
