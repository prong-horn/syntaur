/**
 * Per-window / per-ticket cost from engagement SNAPSHOT deltas — the source
 * of truth for ticket cost attribution (decision-record.md Decision 1/3).
 *
 * `usage_events` is cumulative per `(session_id, model)` with a date-only
 * session-level `event_ts`, so it CANNOT split one session's cost across two
 * tickets it worked in sequence. Each engagement instead snapshots the
 * session's cumulative per-model cost at open and close (`tokens_at_open` /
 * `tokens_at_close`); a window's cost is the per-model `cost` DELTA between them.
 * Summing windows per ticket attributes each window to the right ticket
 * even when the same model spans both (the M2 fix).
 *
 * Cost source: the snapshot already carries ccusage `cost` per model
 * (`ModelTokens.cost`), so the primary path is `close.cost − open.cost`.
 * `priceForModel` is only a FALLBACK (it returns null for claude/codex models),
 * used when the `cost` delta is 0 while tokens grew.
 *
 * Read-only: this module only SELECTs from the `engagement` table (the session
 * db) and prices — it never mutates engagement/usage rows, facts, or status.
 */

import { getSessionDb } from '../dashboard/session-db.js';
import {
  parseSnapshot,
  type ModelTokens,
  type TokenSnapshot,
} from '../db/engagement-tokens.js';
import { priceForModel, type TokenBuckets } from './pricing.js';
import { chunkTicketIds } from '../db/usage-db.js';

export interface WindowCostResult {
  /** Summed per-window snapshot cost (USD) across the matched closed windows. */
  cost: number;
  /** Closed windows with a computable open+close snapshot (counted even if $0). */
  pricedWindowCount: number;
  /** Closed windows with a null open OR close snapshot (contribute 0, surfaced). */
  uncomputableWindowCount: number;
  /** Closed windows that had ≥1 negative per-model cost delta (clamped to 0). */
  negativeDeltaCount: number;
}

export interface TicketWindowCostOpts {
  /** Match key — the engagement's `ticket_id`. */
  ticketId?: string | null;
  /** Legacy slug/id fallback when `ticketId` is absent. */
  ticketSlug?: string | null;
  /** Inclusive `since` (YYYY-MM-DD) — filters windows by `ended_at`. */
  since?: string;
  /** Inclusive `until` (YYYY-MM-DD) — filters windows by `ended_at`. */
  until?: string;
  /** Restrict the per-model delta sum to this single model. */
  model?: string;
}

export interface ProjectWindowCostsOpts {
  /** Ticket ids belonging to the project — engagement rows are scoped to these. */
  ticketIds: string[];
  since?: string;
  until?: string;
  model?: string;
}

export interface TicketWindowCost extends WindowCostResult {
  ticketSlug: string;
  ticketId: string | null;
}

interface EngagementCostRow {
  ticket_id: string | null;
  tokens_at_open: string | null;
  tokens_at_close: string | null;
}

const EMPTY: WindowCostResult = {
  cost: 0,
  pricedWindowCount: 0,
  uncomputableWindowCount: 0,
  negativeDeltaCount: 0,
};

/**
 * The session db iff it is initialized AND carries the `engagement` table, else
 * null. Keeps a cost read best-effort: a usage endpoint must never 500 just
 * because the session db isn't ready (it always is in the dashboard, where both
 * dbs init against the same file).
 */
function engagementDb(): ReturnType<typeof getSessionDb> | null {
  let db: ReturnType<typeof getSessionDb>;
  try {
    db = getSessionDb();
  } catch {
    return null;
  }
  const has = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'engagement'")
    .get();
  return has ? db : null;
}

/** Expand a YYYY-MM-DD bound to an inclusive ISO timestamp for `ended_at` compare. */
function sinceBound(since: string | undefined): string | undefined {
  return since ? `${since}T00:00:00.000Z` : undefined;
}
function untilBound(until: string | undefined): string | undefined {
  return until ? `${until}T23:59:59.999Z` : undefined;
}

function toBuckets(open: ModelTokens | undefined, close: ModelTokens | undefined): TokenBuckets {
  const o = open ?? { input: 0, output: 0, cacheCreation: 0, cacheRead: 0, total: 0, cost: 0 };
  const c = close ?? { input: 0, output: 0, cacheCreation: 0, cacheRead: 0, total: 0, cost: 0 };
  return {
    inputTokens: Math.max(0, c.input - o.input),
    outputTokens: Math.max(0, c.output - o.output),
    cacheCreationTokens: Math.max(0, c.cacheCreation - o.cacheCreation),
    cacheReadTokens: Math.max(0, c.cacheRead - o.cacheRead),
  };
}

/**
 * Cost of ONE window from its open/close snapshots. Returns null when the window
 * is uncomputable (either snapshot missing). `hadNegative` flags a corrupt
 * non-monotonic per-model delta (clamped to 0 — should be rare given the
 * `usage_events` MAX() monotonic guards).
 */
function windowCost(
  openJson: string | null,
  closeJson: string | null,
  modelFilter: string | undefined,
): { cost: number; hadNegative: boolean } | null {
  const open: TokenSnapshot | null = parseSnapshot(openJson);
  const close: TokenSnapshot | null = parseSnapshot(closeJson);
  if (!open || !close) return null;

  let cost = 0;
  let hadNegative = false;
  const models = new Set<string>([
    ...Object.keys(open.models),
    ...Object.keys(close.models),
  ]);
  for (const model of models) {
    if (modelFilter && model !== modelFilter) continue;
    const openCost = open.models[model]?.cost ?? 0;
    const closeCost = close.models[model]?.cost ?? 0;
    let contribution = closeCost - openCost;
    if (contribution < 0) {
      hadNegative = true;
      contribution = 0;
    } else if (contribution === 0) {
      // ccusage may report total_cost=0 even when tokens grew — fall back to the
      // list-rate price of the token delta (only if the model is in the table).
      const buckets = toBuckets(open.models[model], close.models[model]);
      if (
        buckets.inputTokens + buckets.outputTokens + buckets.cacheCreationTokens + buckets.cacheReadTokens >
        0
      ) {
        const priced = priceForModel(model, buckets);
        if (priced && priced > 0) contribution = priced;
      }
    }
    cost += contribution;
  }
  return { cost, hadNegative };
}

/** Roll a set of closed-engagement rows into a {@link WindowCostResult}. */
function rollupWindows(rows: EngagementCostRow[], modelFilter: string | undefined): WindowCostResult {
  const out: WindowCostResult = { ...EMPTY };
  for (const row of rows) {
    const wc = windowCost(row.tokens_at_open, row.tokens_at_close, modelFilter);
    if (wc === null) {
      out.uncomputableWindowCount += 1;
      continue;
    }
    out.pricedWindowCount += 1;
    out.cost += wc.cost;
    if (wc.hadNegative) out.negativeDeltaCount += 1;
  }
  return out;
}

/**
 * Per-ticket cost from its closed engagement windows. Matches by `ticket_id`.
 */
export function ticketWindowCost(opts: TicketWindowCostOpts): WindowCostResult {
  const db = engagementDb();
  if (!db) return { ...EMPTY };
  const ticketId = opts.ticketId ?? opts.ticketSlug;
  if (!ticketId) return { ...EMPTY };

  const clauses = ['ended_at IS NOT NULL', 'ticket_id = ?'];
  const params: unknown[] = [ticketId];

  const since = sinceBound(opts.since);
  const until = untilBound(opts.until);
  if (since) {
    clauses.push('ended_at >= ?');
    params.push(since);
  }
  if (until) {
    clauses.push('ended_at <= ?');
    params.push(until);
  }

  const rows = db
    .prepare(
      `SELECT ticket_id, tokens_at_open, tokens_at_close
         FROM engagement
        WHERE ${clauses.join(' AND ')}`,
    )
    .all(...params) as EngagementCostRow[];
  return rollupWindows(rows, opts.model);
}

/**
 * Per-ticket cost for EVERY ticket in `ticketIds` that has at least one closed
 * engagement window, keyed by `ticket_id`. Ids are de-duplicated and bound in
 * chunks below the SQLite parameter limit (one SELECT per chunk); every
 * ticket's windows land in exactly one chunk, so the per-ticket rollup is
 * identical to a single unchunked query.
 */
export function projectWindowCosts(
  opts: ProjectWindowCostsOpts,
): Map<string, TicketWindowCost> {
  const ids = [...new Set(opts.ticketIds)];
  if (ids.length === 0) return new Map();
  const db = engagementDb();
  if (!db) return new Map();
  const since = sinceBound(opts.since);
  const until = untilBound(opts.until);

  const rows: EngagementCostRow[] = [];
  for (const chunk of chunkTicketIds(ids)) {
    const clauses = ['ended_at IS NOT NULL', `ticket_id IN (${chunk.map(() => '?').join(', ')})`];
    const params: unknown[] = [...chunk];
    if (since) {
      clauses.push('ended_at >= ?');
      params.push(since);
    }
    if (until) {
      clauses.push('ended_at <= ?');
      params.push(until);
    }
    rows.push(
      ...(db
        .prepare(
          `SELECT ticket_id, tokens_at_open, tokens_at_close
             FROM engagement
            WHERE ${clauses.join(' AND ')}`,
        )
        .all(...params) as EngagementCostRow[]),
    );
  }

  const grouped = new Map<string, EngagementCostRow[]>();
  for (const row of rows) {
    const id = row.ticket_id as string;
    const bucket = grouped.get(id);
    if (bucket) bucket.push(row);
    else grouped.set(id, [row]);
  }

  const out = new Map<string, TicketWindowCost>();
  for (const [id, bucket] of grouped) {
    out.set(id, {
      ticketSlug: id,
      ticketId: id,
      ...rollupWindows(bucket, opts.model),
    });
  }
  return out;
}

export interface TicketEngagementTotals {
  /** COUNT(DISTINCT session_id) across ALL windows (open, closed, archived sessions). */
  sessionCount: number;
  /** Windows still open (`ended_at IS NULL`) — unpriced, so recorded spend is partial. */
  openWindowCount: number;
}

/**
 * Distinct engaged sessions + open-window count per ticket id, one GROUP BY
 * per id chunk. Returns null when the session db / engagement table is
 * unavailable (unknown), otherwise a map in which an id with no windows is
 * simply absent (known zero). Null/empty ticket bindings never match.
 */
export function engagementTotalsByTicket(
  ticketIds: readonly string[],
): Map<string, TicketEngagementTotals> | null {
  const db = engagementDb();
  if (!db) return null;
  const out = new Map<string, TicketEngagementTotals>();
  const ids = [...new Set(ticketIds.filter((id) => id !== ''))];
  for (const chunk of chunkTicketIds(ids)) {
    const rows = db
      .prepare(
        `SELECT ticket_id,
                COUNT(DISTINCT session_id) AS session_count,
                SUM(CASE WHEN ended_at IS NULL THEN 1 ELSE 0 END) AS open_count
           FROM engagement
          WHERE ticket_id IN (${chunk.map(() => '?').join(', ')})
          GROUP BY ticket_id`,
      )
      .all(...chunk) as Array<{ ticket_id: string; session_count: number; open_count: number }>;
    for (const r of rows) {
      out.set(r.ticket_id, { sessionCount: r.session_count, openWindowCount: r.open_count });
    }
  }
  return out;
}
