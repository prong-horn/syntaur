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
  type ProjectScope,
} from '../db/usage-db.js';
import {
  ticketWindowCost,
  projectWindowCosts,
  type WindowCostResult,
} from '../usage/engagement-cost.js';
import {
  resolveTicketCost,
  ticketTotals,
  unknownTicketMetrics,
} from '../usage/ticket-totals.js';
import type { TicketCostSource, TicketMetrics, UsageCostBasis } from './types.js';

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
      const common = extractCommonFilter(req.query);
      // A `project` filter selects the project's rows by scope (its current
      // ticket ids + genuine project-only rows) instead of an exact
      // `project_slug` match, which dropped ticket rows whose attribution left
      // the slug empty. All other window/model/tool filters are unchanged.
      let scope: ProjectScope | undefined;
      const filter: ListDailyFilter = { ...common };
      if (common.projectSlug !== undefined) {
        scope = await projectScopeFor(projectsDir, common.projectSlug);
        delete filter.projectSlug;
        filter.projectScope = scope;
      }
      const rows = listDaily(filter);
      const costBasis: UsageCostBasis = 'usage-daily';
      res.json({
        daily: rows,
        summary: summarize(rows, groupByMode(req.query.groupBy), scope?.projectSlug),
        // Windowed usage_daily sums; card/header totals are window-first
        // lifetime (ticket-totals) and may differ.
        costBasis,
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
      const scope = await projectScopeFor(projectsDir, projectSlug);
      const filter: ListDailyFilter = { ...common, projectScope: scope };
      delete filter.projectSlug;
      const rows = listDaily(filter);
      const costBasis: UsageCostBasis = 'window-first';
      res.json({
        projectSlug,
        daily: rows,
        summary: projectTicketRollup(projectSlug, rows, common, [...scope.ticketIds]),
        costBasis,
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
      const ticketId = resolved.id;
      const ticketSlug = resolved.ticketSlug;
      const common = extractCommonFilter(req.query);
      // Ticket ids are globally unique: filter by `ticket_id` ONLY. Attribution
      // can leave `project_slug` empty, so a project match undercounted.
      delete common.projectSlug;
      const dailyRows = listDaily({ ...common, ticketSlug: ticketId });
      const eventRows = listEvents(eventsFilterFromDaily({ ...common, ticketSlug: ticketId }));
      res.json({
        ticketId,
        projectSlug: resolved.projectSlug,
        ticketSlug,
        daily: dailyRows,
        events: eventRows,
        summary: buildTicketSummary(dailyRows, eventRows, {
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

/** The project's CURRENT ticket ids (from the ticket walk) as a usage scope. */
async function projectScopeFor(projectsDir: string, projectSlug: string): Promise<ProjectScope> {
  const { listTicketsByProject } = await import('../utils/ticket-walk.js');
  const walk = await listTicketsByProject(projectsDir);
  const ticketIds = walk.withTicketMd
    .filter((t) => t.projectSlug === projectSlug && t.ticketId)
    .map((t) => t.ticketId as string);
  return { projectSlug, ticketIds };
}

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
  /** Per-ticket project rollups: which ledger `totalCost` came from. */
  costSource?: TicketCostSource;
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
  /**
   * Which ledger the (window/filter-scoped) `totalCost` came from — same
   * precedence as the card/header: priced windows, else attributed
   * `usage_events` rows, else `none` (totalCost 0 means "unknown" then).
   */
  costSource: TicketCostSource;
  /**
   * Lifetime, unfiltered totals from the SAME helper as the board card and
   * ticket header (`ticketTotals`). Unaffected by since/until/model/tool.
   */
  lifetime: TicketMetrics;
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
 * cumulative). `totalCost` follows the card/header precedence within the
 * requested filter: the SNAPSHOT-window cost when a priced window exists (M2 —
 * a session that worked this ticket then another on the same model is not
 * over-attributed), else the SUM of the ticket's attributed `usage_events`
 * rows in the same filter (so the header reconciles with `byModel` instead of
 * showing $0), never both. `lifetime` is the unfiltered `ticketTotals` value.
 */
function buildTicketSummary(
  rows: ReturnType<typeof listDaily>,
  eventRows: ReturnType<typeof listEvents>,
  costKey: TicketCostKey,
): TicketUsageSummary {
  const totals = summarize(rows, 'ticket')[0];
  const windows: WindowCostResult = ticketWindowCost(costKey);
  const usage = {
    cost: eventRows.reduce((acc, r) => acc + r.total_cost, 0),
    rowCount: eventRows.length,
  };
  // Open windows only affect `partial`, which this windowed total doesn't carry
  // (the lifetime block does), so pass 0.
  const cost = resolveTicketCost(windows, usage, 0);
  const ticketId = costKey.ticketId ?? costKey.ticketSlug;
  return {
    totalTokens: totals?.totalTokens ?? 0,
    totalCost: cost.costUsd ?? 0,
    lastEventDay: totals?.lastEventDay ?? null,
    byModel: byModelBreakdown(rows),
    pricedWindowCount: windows.pricedWindowCount,
    uncomputableWindowCount: windows.uncomputableWindowCount,
    negativeDeltaCount: windows.negativeDeltaCount,
    costSource: cost.costSource,
    lifetime: ticketTotals([ticketId]).get(ticketId) ?? unknownTicketMetrics(),
  };
}

/**
 * Group daily rows. `ticket` mode keys attributed rows by `ticket_id` alone
 * (ids are globally unique), so one ticket whose rows carry both an empty and
 * a real `project_slug` is ONE row (with the non-empty slug); unattributed
 * rows (`ticket_id = ''`) stay grouped per project slug. `scopedProjectSlug`
 * (a project-scoped query) labels every row with that project.
 */
function summarize(
  rows: ReturnType<typeof listDaily>,
  mode: GroupByMode,
  scopedProjectSlug?: string,
): SummaryRow[] {
  const map = new Map<string, SummaryRow>();
  for (const r of rows) {
    const projectSlug = scopedProjectSlug ?? r.project_slug;
    const key =
      mode === 'project'
        ? projectSlug
        : r.ticket_id !== ''
          ? `\x01${r.ticket_id}`
          : `${projectSlug}\x00`;
    const existing = map.get(key);
    if (existing) {
      existing.totalTokens += r.total_tokens;
      existing.totalCost += r.total_cost;
      if (r.day > existing.lastEventDay) existing.lastEventDay = r.day;
      if (existing.projectSlug === '' && projectSlug !== '') existing.projectSlug = projectSlug;
    } else {
      map.set(key, {
        projectSlug,
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
 * the UNION of (the scoped `usage_daily` ticket keys) ∪ (the tickets that have
 * a closed engagement snapshot window) — because in an A-then-B same-model
 * session the cumulative `usage_events` row attributes only to the latest
 * ticket, so a ticket with a real window but no `usage_daily` row would
 * otherwise be MISSING entirely. Each row's `totalCost` follows the card/header
 * precedence within the requested filter: the snapshot-window cost when ≥1
 * window is priced, else the ticket's windowed `usage_daily` cost (unpriced
 * attribution is never silently zeroed), labelled by `costSource`. The
 * project-only group (`ticketSlug === ''`) is always `usage`-sourced.
 */
function projectTicketRollup(
  projectSlug: string,
  rows: ReturnType<typeof listDaily>,
  common: CommonFilter,
  ticketIds: string[],
): SummaryRow[] {
  const dailyRowCount = new Map<string, number>();
  for (const r of rows) dailyRowCount.set(r.ticket_id, (dailyRowCount.get(r.ticket_id) ?? 0) + 1);

  const byTicket = new Map<string, SummaryRow>();
  for (const row of summarize(rows, 'ticket', projectSlug)) {
    byTicket.set(row.ticketSlug, row);
  }

  const windows = projectWindowCosts({
    ticketIds,
    since: common.since,
    until: common.until,
    model: common.model,
  });

  for (const [ticketSlug, w] of windows) {
    if (byTicket.has(ticketSlug)) continue;
    // Present ONLY in snapshot windows (no usage_daily row) — surface it so the
    // A-then-B case can't drop it from the rollup.
    byTicket.set(ticketSlug, {
      projectSlug,
      ticketSlug,
      totalTokens: 0,
      totalCost: 0,
      lastEventDay: '',
    });
  }

  for (const row of byTicket.values()) {
    const w = windows.get(row.ticketSlug);
    const rowCount = dailyRowCount.get(row.ticketSlug) ?? 0;
    const cost = resolveTicketCost(w, { cost: row.totalCost, rowCount }, 0);
    row.totalCost = cost.costUsd ?? 0;
    row.costSource = cost.costSource;
    // Counts present on EVERY per-ticket row (0/0/0 without a closed window).
    row.pricedWindowCount = w?.pricedWindowCount ?? 0;
    row.uncomputableWindowCount = w?.uncomputableWindowCount ?? 0;
    row.negativeDeltaCount = w?.negativeDeltaCount ?? 0;
  }

  return [...byTicket.values()].sort(
    (a, b) => b.totalCost - a.totalCost || b.totalTokens - a.totalTokens,
  );
}
