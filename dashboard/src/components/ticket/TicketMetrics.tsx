import { Coins, Users } from 'lucide-react';
import { cn } from '../../lib/utils';
import { formatCost, formatCount } from '../../lib/format';
import type { TicketMetrics as TicketMetricsData } from '../../data/types';

export interface TicketMetricsProps {
  /** From the ticket's own payload (board item or detail); absent ⇒ unknown. */
  metrics: TicketMetricsData | null | undefined;
  /** `card` is the compact board variant; `header` the ticket page header. */
  variant?: 'card' | 'header';
  className?: string;
}

export interface MetricsPresentation {
  cost: { text: string; label: string; detail: string };
  sessions: { text: string; label: string; detail: string };
}

/**
 * Pure presentation of read-time ticket totals, shared by the card and header
 * so both always say the same thing:
 * - no recorded spend renders an em dash (unknown), never `$0`; a recorded
 *   zero renders `$0.00`;
 * - partial engagement-window cost is marked `+` (true spend may be higher);
 * - an unavailable session database renders an em dash; `0` is a real count.
 */
export function presentTicketMetrics(metrics: TicketMetricsData | null | undefined): MetricsPresentation {
  const costUsd = metrics?.costUsd ?? null;
  const source = metrics?.costSource ?? 'none';
  let cost: MetricsPresentation['cost'];
  if (costUsd === null || source === 'none') {
    cost = {
      text: '—',
      label: 'Cost unknown',
      detail: 'No usage has been recorded for this ticket, so its spend is unknown (not $0).',
    };
  } else if (source === 'engagement') {
    const partial = metrics?.partial === true;
    cost = {
      text: `${formatCost(costUsd)}${partial ? '+' : ''}`,
      label: `Lifetime cost ${formatCost(costUsd)}${partial ? ', partial' : ''}`,
      detail: partial
        ? 'Priced from closed engagement windows. Some windows are still open or could not be priced, so actual spend may be higher.'
        : 'Priced from this ticket’s engagement windows.',
    };
  } else {
    cost = {
      text: formatCost(costUsd),
      label: `Lifetime cost ${formatCost(costUsd)}`,
      detail: 'Summed from recorded usage events attributed to this ticket (no priced engagement windows).',
    };
  }

  const count = metrics?.sessionCount ?? null;
  const sessions: MetricsPresentation['sessions'] =
    count === null
      ? {
          text: '—',
          label: 'Session count unknown',
          detail: 'The session database is unavailable, so the number of sessions is unknown.',
        }
      : {
          text: formatCount(count, 'session'),
          label: formatCount(count, 'distinct session'),
          detail:
            'Distinct agent sessions ever engaged with this ticket (closed and archived included). This can exceed the Sessions tab, which lists each session’s latest binding.',
        };
  return { cost, sessions };
}

/** Lifetime cost + distinct session count for a ticket card or header. */
export function TicketMetrics({ metrics, variant = 'card', className }: TicketMetricsProps) {
  const { cost, sessions } = presentTicketMetrics(metrics);
  const compact = variant === 'card';
  return (
    <span
      className={cn(
        'inline-flex items-center text-muted-foreground',
        compact ? 'gap-2 text-xs' : 'gap-3 text-sm',
        className,
      )}
      data-testid="ticket-metrics"
    >
      <span className="inline-flex items-center gap-1" title={cost.detail} aria-label={cost.label} role="img">
        <Coins aria-hidden="true" className={compact ? 'h-3 w-3' : 'h-4 w-4'} />
        <span aria-hidden="true">{cost.text}</span>
      </span>
      <span className="inline-flex items-center gap-1" title={sessions.detail} aria-label={sessions.label} role="img">
        <Users aria-hidden="true" className={compact ? 'h-3 w-3' : 'h-4 w-4'} />
        <span aria-hidden="true">{sessions.text}</span>
      </span>
    </span>
  );
}
