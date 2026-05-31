import { Router } from 'express';
import { initUsageDb, listDaily, listEvents, type ListEventsFilter } from '../db/usage-db.js';

/**
 * Token-usage dashboard API. Read-only; localhost-only per existing
 * dashboard convention (no auth). Mirrors `api-leases.ts`'s router shape.
 *
 * Endpoints — all accept `?since=YYYY-MM-DD&until=YYYY-MM-DD&tool=&groupBy=`:
 *   GET /                                            — top-level summary
 *   GET /projects/:projectSlug                       — per-assignment rollup for a project
 *   GET /projects/:projectSlug/assignments/:assignmentSlug
 *                                                    — event detail for one project-scoped assignment
 *   GET /standalone/:assignmentId                    — UUID-keyed standalone variant
 */
export function createUsageRouter(): Router {
  const router = Router();

  router.get('/', (req, res) => {
    try {
      initUsageDb();
      const filter = extractCommonFilter(req.query);
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

  router.get('/projects/:projectSlug', (req, res) => {
    try {
      initUsageDb();
      const projectSlug = req.params.projectSlug;
      const rows = listDaily({
        ...extractCommonFilter(req.query),
        projectSlug,
      });
      res.json({
        projectSlug,
        daily: rows,
        summary: summarize(rows, 'assignment'),
      });
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : 'List failed',
      });
    }
  });

  router.get('/projects/:projectSlug/assignments/:assignmentSlug', (req, res) => {
    try {
      initUsageDb();
      const { projectSlug, assignmentSlug } = req.params;
      const common = extractCommonFilter(req.query);
      const dailyRows = listDaily({
        ...common,
        projectSlug,
        assignmentSlug,
      });
      const eventRows = listEvents(
        eventsFilterFromDaily({ ...common, projectSlug, assignmentSlug }),
      );
      res.json({
        projectSlug,
        assignmentSlug,
        daily: dailyRows,
        events: eventRows,
        summary: buildAssignmentSummary(dailyRows),
      });
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : 'List failed',
      });
    }
  });

  router.get('/standalone/:assignmentId', (req, res) => {
    try {
      initUsageDb();
      const assignmentSlug = req.params.assignmentId;
      const common = extractCommonFilter(req.query);
      const dailyRows = listDaily({
        ...common,
        projectSlug: '',
        assignmentSlug,
      });
      const eventRows = listEvents(
        eventsFilterFromDaily({ ...common, projectSlug: '', assignmentSlug }),
      );
      res.json({
        assignmentId: assignmentSlug,
        daily: dailyRows,
        events: eventRows,
        summary: buildAssignmentSummary(dailyRows),
      });
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : 'List failed',
      });
    }
  });

  return router;
}

// --- internals ------------------------------------------------------------

interface CommonFilter {
  since?: string;
  until?: string;
  tool?: string;
  projectSlug?: string;
  assignmentSlug?: string;
}

function extractCommonFilter(query: Record<string, unknown>): CommonFilter {
  const out: CommonFilter = {};
  if (typeof query.since === 'string') out.since = query.since;
  if (typeof query.until === 'string') out.until = query.until;
  if (typeof query.tool === 'string') out.tool = query.tool;
  if (typeof query.project === 'string') out.projectSlug = query.project;
  if (typeof query.assignment === 'string') out.assignmentSlug = query.assignment;
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
  if (common.projectSlug !== undefined) out.projectSlug = common.projectSlug;
  if (common.assignmentSlug !== undefined) out.assignmentSlug = common.assignmentSlug;
  return out;
}

type GroupByMode = 'project' | 'assignment';

function groupByMode(q: unknown): GroupByMode {
  return q === 'assignment' ? 'assignment' : 'project';
}

interface SummaryRow {
  projectSlug: string;
  assignmentSlug: string;
  totalTokens: number;
  totalCost: number;
  lastEventDay: string;
}

/** Per-model token/cost breakdown for one assignment. */
export interface ModelUsage {
  model: string;
  totalTokens: number;
  totalCost: number;
}

/**
 * Pre-aggregated usage totals for a single assignment, surfaced on the
 * assignment detail page. `lastEventDay` is `null` when there is no usage yet
 * (the panel renders a calm empty state in that case).
 */
export interface AssignmentUsageSummary {
  totalTokens: number;
  totalCost: number;
  lastEventDay: string | null;
  byModel: ModelUsage[];
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
 * Roll a single assignment's daily rows into an {@link AssignmentUsageSummary}.
 * Reuses {@link summarize} for the grand totals + `lastEventDay` (its single
 * `'assignment'` group), defaulting to zero/`null` when there are no rows.
 */
function buildAssignmentSummary(
  rows: ReturnType<typeof listDaily>,
): AssignmentUsageSummary {
  const totals = summarize(rows, 'assignment')[0];
  return {
    totalTokens: totals?.totalTokens ?? 0,
    totalCost: totals?.totalCost ?? 0,
    lastEventDay: totals?.lastEventDay ?? null,
    byModel: byModelBreakdown(rows),
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
        : `${r.project_slug}\x00${r.assignment_slug}`;
    const existing = map.get(key);
    if (existing) {
      existing.totalTokens += r.total_tokens;
      existing.totalCost += r.total_cost;
      if (r.day > existing.lastEventDay) existing.lastEventDay = r.day;
    } else {
      map.set(key, {
        projectSlug: r.project_slug,
        assignmentSlug: mode === 'project' ? '' : r.assignment_slug,
        totalTokens: r.total_tokens,
        totalCost: r.total_cost,
        lastEventDay: r.day,
      });
    }
  }
  return [...map.values()].sort((a, b) => b.totalTokens - a.totalTokens);
}
