import { Router, type RequestHandler } from 'express';
import { resolveTicketById } from '../utils/ticket-resolver.js';
import {
  initUsageDb,
  listDaily,
  listDistinctModels,
  listDistinctTools,
  listEvents,
  type ListDailyFilter,
  type ListEventsFilter,
} from '../db/usage-db.js';
import {
  ticketWindowCost,
  projectWindowCosts,
  type WindowCostResult,
} from '../usage/engagement-cost.js';

/**
 * Token-usage dashboard API. Read-only; localhost-only per existing
 * dashboard convention (no auth). Mirrors other read-only dashboard routers.
 *
 * Endpoints — all accept `?since=YYYY-MM-DD&until=YYYY-MM-DD&tool=&groupBy=`:
 *   GET /                                            — top-level summary
 *   GET /projects/:projectSlug                       — per-ticket rollup for a project
 *
 * Per-ticket detail is served at `GET /api/tickets/:id/usage` (see
 * `getTicketUsageHandler`).
 */
export function createUsageRouter(projectsDir: string): Router {
  const router = Router();

  // Distinct model/tool facets for the widget + config-dialog dropdowns. Literal
  // path — registered before the `/:param` routes so it is never shadowed.
  router.get('/facets', (_req, res) => {
    try {
      initUsageDb();
      res.json({ models: listDistinctModels(), tools: listDistinctTools() });
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : 'List failed',
      });
    }
  });

  router.get('/', async (req, res) => {
    try {
      initUsageDb();
      const filter: ListDailyFilter = extractCommonFilter(req.query);
      const rows = listDaily(filter);
      res.json({
        daily: rows,
        summary: summarize(rows, groupByMode(req.query.groupBy)),
      });
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : 'List failed',
      });
    }
  });

  router.get('/projects/:projectSlug', async (req, res) => {
    try {
      initUsageDb();
      const projectSlug = req.params.projectSlug;
      const common = extractCommonFilter(req.query);
      const rows = listDaily({ ...common, projectSlug });
      const { listTicketsByProject } = await import('../utils/ticket-walk.js');
      const walk = await listTicketsByProject(projectsDir);
      const ticketIds = walk.withTicketMd
        .filter((t) => t.projectSlug === projectSlug && t.ticketId)
        .map((t) => t.ticketId as string);
      res.json({
        projectSlug,
        daily: rows,
        summary: projectTicketRollup(projectSlug, rows, common, ticketIds),
      });
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : 'List failed',
      });
    }
  });

  return router;
}

export function getTicketUsageHandler(projectsDir: string): RequestHandler {
  return async (req, res) => {
    try {
      initUsageDb();
      const id = typeof req.params.id === 'string' ? req.params.id : req.params.id[0];
      const resolved = await resolveTicketById(projectsDir, id);
      if (!resolved) {
        res.status(404).json({ error: `Ticket "${id}" not found` });
        return;
      }
      const projectSlug = resolved.projectSlug ?? '';
      const ticketId = resolved.id;
      const ticketSlug = resolved.ticketSlug;
      const common = extractCommonFilter(req.query);
      const dailyRows = listDaily({
        ...common,
        projectSlug,
        ticketSlug: ticketId,
      });
      const eventRows = listEvents(
        eventsFilterFromDaily({ ...common, projectSlug, ticketSlug: ticketId }),
      );
      res.json({
        ticketId,
        projectSlug: resolved.projectSlug,
        ticketSlug,
        daily: dailyRows,
        events: eventRows,
        summary: buildTicketSummary(dailyRows, {
          ticketId,
          projectSlug: resolved.projectSlug,
          ticketSlug,
          since: common.since,
          until: common.until,
          model: common.model,
        }),
      });
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : 'List failed',
      });
    }
  };
}

// --- internals ------------------------------------------------------------

interface CommonFilter {
  since?: string;
  until?: string;
  tool?: string;
  model?: string;
  projectSlug?: string;
  ticketSlug?: string;
}

function extractCommonFilter(query: Record<string, unknown>): CommonFilter {
  const out: CommonFilter = {};
  if (typeof query.since === 'string') out.since = query.since;
  if (typeof query.until === 'string') out.until = query.until;
  if (typeof query.tool === 'string') out.tool = query.tool;
  if (typeof query.model === 'string') out.model = query.model;
  if (typeof query.project === 'string') out.projectSlug = query.project;
  if (typeof query.ticket === 'string') out.ticketSlug = query.ticket;
  return out;
}

/**
 * Translate a day-granular daily filter into an event filter. `usage_daily.day`
 * is YYYY-MM-DD; `usage_events.event_ts` is full ISO 8601. Expand the day
 * bounds to inclusive ISO ranges so an `until=2026-05-21` covers everything
 * through end-of-day UTC.
 */
function eventsFilterFromDaily(common: CommonFilter): ListEventsFilter {
  const out: ListEventsFilter = {};
  if (common.since) out.since = `${common.since}T00:00:00.000Z`;
  if (common.until) out.until = `${common.until}T23:59:59.999Z`;
  if (common.tool) out.tool = common.tool;
  if (common.model) out.model = common.model;
  if (common.projectSlug !== undefined) out.projectSlug = common.projectSlug;
  if (common.ticketSlug !== undefined) out.ticketSlug = common.ticketSlug;
  return out;
}

type GroupByMode = 'project' | 'ticket';

function groupByMode(q: unknown): GroupByMode {
  return q === 'ticket' ? 'ticket' : 'project';
}

interface SummaryRow {
  projectSlug: string;
  ticketSlug: string;
  totalTokens: number;
  totalCost: number;
  lastEventDay: string;
  /** Snapshot-window confidence counts (M2) — present on per-ticket rollups. */
  pricedWindowCount?: number;
  uncomputableWindowCount?: number;
  negativeDeltaCount?: number;
}

/** Per-model token/cost breakdown for one ticket. */
export interface ModelUsage {
  model: string;
  totalTokens: number;
  totalCost: number;
}

/**
 * Pre-aggregated usage totals for a single ticket, surfaced on the
 * ticket detail page. `lastEventDay` is `null` when there is no usage yet
 * (the panel renders a calm empty state in that case).
 */
export interface TicketUsageSummary {
  totalTokens: number;
  /**
   * Per-ticket cost from engagement SNAPSHOT windows (M2 / Decision 1) — NOT
   * the cumulative `usage_events` row, which can't split a multi-ticket
   * session's cost. The window-count fields flag confidence.
   */
  totalCost: number;
  lastEventDay: string | null;
  byModel: ModelUsage[];
  pricedWindowCount: number;
  uncomputableWindowCount: number;
  negativeDeltaCount: number;
}

/** The (id-or-slugs) key + filters identifying one ticket's cost windows. */
interface TicketCostKey {
  ticketId?: string | null;
  projectSlug: string | null;
  ticketSlug: string;
  since?: string;
  until?: string;
  model?: string;
}

/** Group daily rows by model, summing tokens/cost (highest tokens first). */
function byModelBreakdown(rows: ReturnType<typeof listDaily>): ModelUsage[] {
  const map = new Map<string, ModelUsage>();
  for (const r of rows) {
    const existing = map.get(r.model);
    if (existing) {
      existing.totalTokens += r.total_tokens;
      existing.totalCost += r.total_cost;
    } else {
      map.set(r.model, {
        model: r.model,
        totalTokens: r.total_tokens,
        totalCost: r.total_cost,
      });
    }
  }
  return [...map.values()].sort((a, b) => b.totalTokens - a.totalTokens);
}

/**
 * Roll a single ticket's daily rows into an {@link TicketUsageSummary}.
 * Tokens/`lastEventDay`/`byModel` come from `usage_daily` (legitimately
 * cumulative), but `totalCost` is the SNAPSHOT-window cost for the ticket
 * (M2) — so a session that worked this ticket then another on the same model
 * is not over-attributed the whole cumulative.
 */
function buildTicketSummary(
  rows: ReturnType<typeof listDaily>,
  costKey: TicketCostKey,
): TicketUsageSummary {
  const totals = summarize(rows, 'ticket')[0];
  const windows: WindowCostResult = ticketWindowCost(costKey);
  // When the ticket has NO computable engagement window (e.g. usage attributed
  // by slug to a ticket that never registered an agent session), the window
  // ledger has nothing to attribute and `windows.cost` is 0 — but `byModel` still
  // sums the cumulative `usage_daily` cost. Showing $0 over a non-zero breakdown is
  // the reconciliation bug. With no window to split, the cumulative daily cost is
  // the best (and self-consistent) estimate, so fall back to it. Whenever a real
  // priced window exists, keep the snapshot-window cost (the M2 attribution model),
  // including a legitimately $0-cost window.
  const totalCost = windows.pricedWindowCount > 0 ? windows.cost : totals?.totalCost ?? 0;
  return {
    totalTokens: totals?.totalTokens ?? 0,
    totalCost,
    lastEventDay: totals?.lastEventDay ?? null,
    byModel: byModelBreakdown(rows),
    pricedWindowCount: windows.pricedWindowCount,
    uncomputableWindowCount: windows.uncomputableWindowCount,
    negativeDeltaCount: windows.negativeDeltaCount,
  };
}

function summarize(
  rows: ReturnType<typeof listDaily>,
  mode: GroupByMode,
): SummaryRow[] {
  const map = new Map<string, SummaryRow>();
  for (const r of rows) {
    const key =
      mode === 'project'
        ? r.project_slug
        : `${r.project_slug}\x00${r.ticket_id}`;
    const existing = map.get(key);
    if (existing) {
      existing.totalTokens += r.total_tokens;
      existing.totalCost += r.total_cost;
      if (r.day > existing.lastEventDay) existing.lastEventDay = r.day;
    } else {
      map.set(key, {
        projectSlug: r.project_slug,
        ticketSlug: mode === 'project' ? '' : r.ticket_id,
        totalTokens: r.total_tokens,
        totalCost: r.total_cost,
        lastEventDay: r.day,
      });
    }
  }
  return [...map.values()].sort((a, b) => b.totalTokens - a.totalTokens);
}

/**
 * Per-ticket rollup for a project's usage page (M2). The ticket SET is
 * the UNION of (the `usage_daily` ticket keys) ∪ (the tickets that have
 * a closed engagement snapshot window) — because in an A-then-B same-model
 * session the cumulative `usage_events` row attributes only to the latest
 * ticket, so a ticket with a real window but no `usage_daily` row would
 * otherwise be MISSING entirely. Each row's `totalCost` is the snapshot-window
 * cost (the per-ticket source of truth); tokens stay from `usage_daily`.
 */
function projectTicketRollup(
  projectSlug: string,
  rows: ReturnType<typeof listDaily>,
  common: CommonFilter,
  ticketIds: string[],
): SummaryRow[] {
  // Start from the usage_daily groups but RESET cost to 0 — per-ticket cost
  // is snapshot-derived (overlaid below), never the cumulative usage_events row.
  // A daily-only ticket with no closed window stays at 0 (its window cost is
  // not yet computable), consistent with the ticket-detail summary.
  const byTicket = new Map<string, SummaryRow>();
  for (const row of summarize(rows, 'ticket')) {
    byTicket.set(row.ticketSlug, {
      ...row,
      totalCost: 0,
      // Counts present on EVERY per-ticket row (a daily-only ticket with
      // no closed window stays at 0/0/0); window overlay below replaces them.
      pricedWindowCount: 0,
      uncomputableWindowCount: 0,
      negativeDeltaCount: 0,
    });
  }

  const windows = projectWindowCosts({
    ticketIds,
    since: common.since,
    until: common.until,
    model: common.model,
  });

  for (const [ticketSlug, w] of windows) {
    const existing = byTicket.get(ticketSlug);
    if (existing) {
      existing.totalCost = w.cost;
      existing.pricedWindowCount = w.pricedWindowCount;
      existing.uncomputableWindowCount = w.uncomputableWindowCount;
      existing.negativeDeltaCount = w.negativeDeltaCount;
    } else {
      // Present ONLY in snapshot windows (no usage_daily row) — surface it with
      // its window cost so the A-then-B case can't drop it from the rollup.
      byTicket.set(ticketSlug, {
        projectSlug,
        ticketSlug,
        totalTokens: 0,
        totalCost: w.cost,
        lastEventDay: '',
        pricedWindowCount: w.pricedWindowCount,
        uncomputableWindowCount: w.uncomputableWindowCount,
        negativeDeltaCount: w.negativeDeltaCount,
      });
    }
  }

  return [...byTicket.values()].sort(
    (a, b) => b.totalCost - a.totalCost || b.totalTokens - a.totalTokens,
  );
}
