/**
 * Read-time lifetime ticket totals for the dashboard header and board cards.
 *
 * Batched: for any number of ids this issues a bounded number of statements —
 * one `projectWindowCosts` SELECT, one `usage_events` GROUP BY and one
 * `engagement` GROUP BY per {@link TICKET_ID_CHUNK_SIZE} ids (plus the
 * engagement-table existence probe) — never one query per ticket.
 *
 * Cost precedence (never add both paths, never sum usage_daily + usage_events):
 *   1. ≥1 priced closed engagement window → the snapshot-window cost
 *      (`projectWindowCosts`, existing pricing/negative-delta policy reused).
 *   2. else ≥1 `usage_events` row attributed to the ticket id (regardless of
 *      `project_slug`, including a recorded $0) → SUM(total_cost).
 *   3. else unknown: `costUsd: null`, `costSource: 'none'`.
 *
 * Session count is COUNT(DISTINCT session_id) over ALL engagement windows for
 * the ticket (open/closed, archived sessions included). It is null exactly when
 * the session db (engagement table) is unavailable, 0 for a queried-empty set.
 *
 * Read-only: nothing is persisted to tickets, frontmatter or derived indexes.
 */

import type { TicketCostSource, TicketMetrics } from '../dashboard/types.js';
import { isUsageDbInitialized, usageEventTotalsByTicket, type TicketUsageEventTotal } from '../db/usage-db.js';
import {
  engagementTotalsByTicket,
  projectWindowCosts,
  type WindowCostResult,
} from './engagement-cost.js';

export type { TicketCostSource, TicketMetrics } from '../dashboard/types.js';

/**
 * Pure cost-precedence rule shared by {@link ticketTotals} and the usage API
 * (`buildTicketSummary`), so the header/card and the usage panel agree.
 */
export function resolveTicketCost(
  window: WindowCostResult | undefined,
  usage: TicketUsageEventTotal | undefined,
  openWindowCount: number,
): { costUsd: number | null; costSource: TicketCostSource; partial: boolean } {
  if (window && window.pricedWindowCount > 0) {
    return {
      costUsd: window.cost,
      costSource: 'engagement',
      partial:
        window.uncomputableWindowCount > 0 || openWindowCount > 0 || window.negativeDeltaCount > 0,
    };
  }
  if (usage && usage.rowCount > 0) {
    return { costUsd: usage.cost, costSource: 'usage', partial: false };
  }
  return { costUsd: null, costSource: 'none', partial: false };
}

/**
 * Lifetime metrics for every id in `ticketIds` (duplicates collapse; every
 * input id gets an entry). A usage db that was never initialized is treated
 * as "no usage rows" rather than an error.
 */
export function ticketTotals(ticketIds: readonly string[]): Map<string, TicketMetrics> {
  const ids = [...new Set(ticketIds)];
  const queryIds = ids.filter((id) => id !== '');

  const windows = projectWindowCosts({ ticketIds: queryIds });
  const usage = isUsageDbInitialized() ? usageEventTotalsByTicket(queryIds) : new Map();
  const engagement = engagementTotalsByTicket(queryIds);

  const out = new Map<string, TicketMetrics>();
  for (const id of ids) {
    const eng = engagement?.get(id);
    const cost = resolveTicketCost(windows.get(id), usage.get(id), eng?.openWindowCount ?? 0);
    out.set(id, {
      costUsd: cost.costUsd,
      sessionCount: engagement === null ? null : eng?.sessionCount ?? 0,
      costSource: cost.costSource,
      partial: cost.partial,
    });
  }
  return out;
}

/** Metrics for an id missing from a {@link ticketTotals} map (defensive default). */
export function unknownTicketMetrics(): TicketMetrics {
  return { costUsd: null, sessionCount: null, costSource: 'none', partial: false };
}
