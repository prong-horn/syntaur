import { SectionCard } from './SectionCard';
import { EmptyState } from './EmptyState';
import { LoadingState } from './LoadingState';
import { formatRelativeTime, formatShortDateTime, toTitleCase } from '../lib/format';
import type { ActivityEvent } from '../hooks/useAssignmentEvents';

interface ActivityTimelineProps {
  events: ActivityEvent[];
  loading?: boolean;
  error?: string | null;
}

/** Human label for a v1 event `type` (falls back to title-casing the raw type). */
const TYPE_LABELS: Record<string, string> = {
  'status-change': 'Status changed',
  'assignee-change': 'Assignee changed',
  'priority-change': 'Priority changed',
  archived: 'Archived',
  restored: 'Restored',
  'plan-approval': 'Plan approved',
  'fact-set': 'Fact set',
  'fact-clear': 'Fact cleared',
  attestation: 'Attestation',
  'comment-added': 'Comment added',
  'comment-resolved': 'Comment resolved',
};

function typeLabel(type: string): string {
  return TYPE_LABELS[type] ?? toTitleCase(type);
}

/** Read a string-ish field from a parsed details object. */
function detailStr(
  details: Record<string, unknown> | null,
  key: string,
): string | null {
  if (!details) return null;
  const value = details[key];
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return null;
}

/**
 * The "gist" of an event's details, rendered as React nodes (never raw HTML).
 * Prefers a `from → to` change pair; otherwise a `name`/`value` or `name`
 * summary; otherwise a compact key list. Returns null when there's nothing
 * meaningful to show.
 */
function EventGist({ event }: { event: ActivityEvent }) {
  const { details } = event;
  if (!details) return null;

  const from = detailStr(details, 'from');
  const to = detailStr(details, 'to');
  if (from !== null || to !== null) {
    return (
      <span className="inline-flex flex-wrap items-center gap-1.5 text-xs">
        {from !== null ? (
          <code className="rounded bg-muted/60 px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
            {from}
          </code>
        ) : null}
        <span aria-hidden="true" className="text-muted-foreground">
          →
        </span>
        {to !== null ? (
          <code className="rounded bg-muted/60 px-1.5 py-0.5 font-mono text-[11px] text-foreground">
            {to}
          </code>
        ) : (
          <span className="text-muted-foreground">(none)</span>
        )}
      </span>
    );
  }

  const name = detailStr(details, 'name');
  const value = detailStr(details, 'value');
  if (name !== null) {
    return (
      <span className="text-xs text-muted-foreground">
        <span className="font-medium text-foreground">{name}</span>
        {value !== null ? <>: {value}</> : null}
      </span>
    );
  }

  const reason = detailStr(details, 'reason');
  if (reason !== null) {
    return <span className="text-xs text-muted-foreground">{reason}</span>;
  }

  const author = detailStr(details, 'author');
  if (author !== null) {
    return (
      <span className="text-xs text-muted-foreground">
        by <span className="font-medium text-foreground">{author}</span>
      </span>
    );
  }

  // Fallback: list the detail keys so nothing is silently dropped (no values,
  // to avoid surfacing anything unexpected).
  const keys = Object.keys(details);
  if (keys.length === 0) return null;
  return (
    <span className="text-xs text-muted-foreground">{keys.join(', ')}</span>
  );
}

/**
 * Renders an assignment's audit-timeline events newest-first. Each row shows the
 * event time (relative + absolute on hover), actor, a human label for the type,
 * and a `from → to` / details gist. All values render as React nodes — never
 * `dangerouslySetInnerHTML`. Empty-state when there are no events.
 */
export function ActivityTimeline({ events, loading, error }: ActivityTimelineProps) {
  if (loading && events.length === 0) {
    return <LoadingState label="Loading activity…" />;
  }

  if (error && events.length === 0) {
    return (
      <EmptyState
        title="Activity unavailable"
        description="The event log could not be loaded. The rest of this page is unaffected."
      />
    );
  }

  if (events.length === 0) {
    return (
      <EmptyState
        title="No activity yet"
        description="Status changes, approvals, comments, and other tracked mutations appear here as a chronological audit trail."
      />
    );
  }

  return (
    <SectionCard
      title="Activity"
      description="Reverse-chronological audit trail of tracked changes to this assignment — who changed what, when."
    >
      <ol className="space-y-3">
        {events.map((event) => (
          <li
            key={event.event_id}
            className="flex flex-col gap-1 border-l-2 border-border pl-3"
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded-full border border-border/60 px-2 py-0.5 text-[11px] font-medium text-foreground">
                {typeLabel(event.type)}
              </span>
              <span className="text-xs text-muted-foreground">{event.actor}</span>
              <span
                className="ml-auto text-xs text-muted-foreground"
                title={formatShortDateTime(event.at)}
              >
                {formatRelativeTime(event.at)}
              </span>
            </div>
            <EventGist event={event} />
          </li>
        ))}
      </ol>
    </SectionCard>
  );
}
