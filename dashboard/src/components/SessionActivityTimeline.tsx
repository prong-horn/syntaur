import { SectionCard } from './SectionCard';
import { EmptyState } from './EmptyState';
import { CopyButton } from './CopyButton';
import {
  formatRelativeTime,
  formatShortDateTime,
  formatDuration,
  toTitleCase,
} from '../lib/format';
import type { EngagementInfo } from '../hooks/useProjects';

interface SessionActivityTimelineProps {
  engagements: EngagementInfo[];
}

/**
 * Per-session stage attribution for an assignment: each engagement interval
 * shows which agent/session worked it, in which **stage** (plan/implement/
 * review — the engagement's own stage, NOT the derived assignment phase), and
 * when (started/ended + duration). Open intervals (`endedAt == null`) render an
 * "In progress" badge and a live elapsed duration with no negative value.
 * Chronological, oldest first. Empty-state when there are no engagements.
 */
export function SessionActivityTimeline({
  engagements,
}: SessionActivityTimelineProps) {
  if (engagements.length === 0) {
    return (
      <EmptyState
        title="No session activity"
        description="When an agent session works this assignment in a plan, implement, or review stage, each interval appears here as a chronological attribution trail."
      />
    );
  }

  return (
    <SectionCard
      title="Session Activity"
      description="Per-session stage attribution — which agent session worked this assignment, in which stage, and when."
    >
      <ol className="space-y-3">
        {engagements.map((engagement) => {
          const open = engagement.endedAt === null;
          const shortId = engagement.sessionId.slice(0, 8);
          return (
            <li
              key={engagement.id}
              className="flex flex-col gap-1 border-l-2 border-border pl-3"
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="rounded-full border border-border/60 px-2 py-0.5 text-[11px] font-medium text-foreground">
                  {toTitleCase(engagement.stage)}
                </span>
                <span className="text-xs text-muted-foreground">
                  {engagement.agent ?? '—'}
                </span>
                <span className="inline-flex items-center gap-1">
                  <code
                    className="rounded bg-muted/60 px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground"
                    title={engagement.sessionId}
                  >
                    {shortId}
                  </code>
                  <CopyButton
                    value={engagement.sessionId}
                    label={`Copy session id ${engagement.sessionId}`}
                  />
                </span>
                {open ? (
                  <span className="ml-auto rounded-full border border-border/60 bg-muted/40 px-2 py-0.5 text-[11px] font-medium text-foreground">
                    In progress
                  </span>
                ) : (
                  <span
                    className="ml-auto text-xs text-muted-foreground"
                    title={formatShortDateTime(engagement.startedAt)}
                  >
                    {formatRelativeTime(engagement.startedAt)}
                  </span>
                )}
              </div>
              <div className="text-xs text-muted-foreground">
                Started{' '}
                <span title={formatRelativeTime(engagement.startedAt)}>
                  {formatShortDateTime(engagement.startedAt)}
                </span>{' '}
                &middot; Ended{' '}
                {engagement.endedAt ? (
                  <span title={formatRelativeTime(engagement.endedAt)}>
                    {formatShortDateTime(engagement.endedAt)}
                  </span>
                ) : (
                  'in progress'
                )}{' '}
                &middot; {formatDuration(engagement.startedAt, engagement.endedAt)}
              </div>
            </li>
          );
        })}
      </ol>
    </SectionCard>
  );
}
