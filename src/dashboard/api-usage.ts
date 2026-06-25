import { Router } from 'express';
import {
  initUsageDb,
  listDaily,
  listDistinctModels,
  listDistinctTools,
  listEvents,
  type ListDailyFilter,
  type ListEventsFilter,
} from '../db/usage-db.js';
import { resolveWorkspaceMembers } from './api.js';
import {
  assignmentWindowCost,
  projectWindowCosts,
  type WindowCostResult,
} from '../usage/engagement-cost.js';

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
export function createUsageRouter(
  projectsDir: string,
  assignmentsDir: string | undefined,
): Router {
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
      const workspace = typeof req.query.workspace === 'string' ? req.query.workspace : undefined;
      if (workspace) {
        // Workspace is mutually exclusive with project/assignment scoping.
        if (filter.projectSlug !== undefined || filter.assignmentSlug !== undefined) {
          res.status(400).json({ error: 'Specify either project/assignment or workspace, not both' });
          return;
        }
        filter.workspaceMembers = await resolveWorkspaceMembers(projectsDir, assignmentsDir, workspace);
      }
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
      const common = extractCommonFilter(req.query);
      const rows = listDaily({ ...common, projectSlug });
      res.json({
        projectSlug,
        daily: rows,
        summary: projectAssignmentRollup(projectSlug, rows, common),
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
        summary: buildAssignmentSummary(dailyRows, {
          projectSlug,
          assignmentSlug,
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
        // Standalone: engagement stores `project_slug IS NULL` (the reader maps
        // a null/empty projectSlug to the NULL match).
        summary: buildAssignmentSummary(dailyRows, {
          projectSlug: null,
          assignmentSlug,
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
  });

  return router;
}

// --- internals ------------------------------------------------------------

interface CommonFilter {
  since?: string;
  until?: string;
  tool?: string;
  model?: string;
  projectSlug?: string;
  assignmentSlug?: string;
}

function extractCommonFilter(query: Record<string, unknown>): CommonFilter {
  const out: CommonFilter = {};
  if (typeof query.since === 'string') out.since = query.since;
  if (typeof query.until === 'string') out.until = query.until;
  if (typeof query.tool === 'string') out.tool = query.tool;
  if (typeof query.model === 'string') out.model = query.model;
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
  if (common.model) out.model = common.model;
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
  /** Snapshot-window confidence counts (M2) — present on per-assignment rollups. */
  pricedWindowCount?: number;
  uncomputableWindowCount?: number;
  negativeDeltaCount?: number;
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
  /**
   * Per-assignment cost from engagement SNAPSHOT windows (M2 / Decision 1) — NOT
   * the cumulative `usage_events` row, which can't split a multi-assignment
   * session's cost. The window-count fields flag confidence.
   */
  totalCost: number;
  lastEventDay: string | null;
  byModel: ModelUsage[];
  pricedWindowCount: number;
  uncomputableWindowCount: number;
  negativeDeltaCount: number;
}

/** The (id-or-slugs) key + filters identifying one assignment's cost windows. */
interface AssignmentCostKey {
  assignmentId?: string | null;
  projectSlug: string | null;
  assignmentSlug: string;
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
 * Roll a single assignment's daily rows into an {@link AssignmentUsageSummary}.
 * Tokens/`lastEventDay`/`byModel` come from `usage_daily` (legitimately
 * cumulative), but `totalCost` is the SNAPSHOT-window cost for the assignment
 * (M2) — so a session that worked this assignment then another on the same model
 * is not over-attributed the whole cumulative.
 */
function buildAssignmentSummary(
  rows: ReturnType<typeof listDaily>,
  costKey: AssignmentCostKey,
): AssignmentUsageSummary {
  const totals = summarize(rows, 'assignment')[0];
  const windows: WindowCostResult = assignmentWindowCost(costKey);
  return {
    totalTokens: totals?.totalTokens ?? 0,
    totalCost: windows.cost,
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

/**
 * Per-assignment rollup for a project's usage page (M2). The assignment SET is
 * the UNION of (the `usage_daily` assignment keys) ∪ (the assignments that have
 * a closed engagement snapshot window) — because in an A-then-B same-model
 * session the cumulative `usage_events` row attributes only to the latest
 * assignment, so an assignment with a real window but no `usage_daily` row would
 * otherwise be MISSING entirely. Each row's `totalCost` is the snapshot-window
 * cost (the per-assignment source of truth); tokens stay from `usage_daily`.
 */
function projectAssignmentRollup(
  projectSlug: string,
  rows: ReturnType<typeof listDaily>,
  common: CommonFilter,
): SummaryRow[] {
  // Start from the usage_daily groups but RESET cost to 0 — per-assignment cost
  // is snapshot-derived (overlaid below), never the cumulative usage_events row.
  // A daily-only assignment with no closed window stays at 0 (its window cost is
  // not yet computable), consistent with the assignment-detail summary.
  const byAssignment = new Map<string, SummaryRow>();
  for (const row of summarize(rows, 'assignment')) {
    byAssignment.set(row.assignmentSlug, {
      ...row,
      totalCost: 0,
      // Counts present on EVERY per-assignment row (a daily-only assignment with
      // no closed window stays at 0/0/0); window overlay below replaces them.
      pricedWindowCount: 0,
      uncomputableWindowCount: 0,
      negativeDeltaCount: 0,
    });
  }

  const windows = projectWindowCosts({
    projectSlug,
    since: common.since,
    until: common.until,
    model: common.model,
  });

  for (const [assignmentSlug, w] of windows) {
    const existing = byAssignment.get(assignmentSlug);
    if (existing) {
      existing.totalCost = w.cost;
      existing.pricedWindowCount = w.pricedWindowCount;
      existing.uncomputableWindowCount = w.uncomputableWindowCount;
      existing.negativeDeltaCount = w.negativeDeltaCount;
    } else {
      // Present ONLY in snapshot windows (no usage_daily row) — surface it with
      // its window cost so the A-then-B case can't drop it from the rollup.
      byAssignment.set(assignmentSlug, {
        projectSlug,
        assignmentSlug,
        totalTokens: 0,
        totalCost: w.cost,
        lastEventDay: '',
        pricedWindowCount: w.pricedWindowCount,
        uncomputableWindowCount: w.uncomputableWindowCount,
        negativeDeltaCount: w.negativeDeltaCount,
      });
    }
  }

  return [...byAssignment.values()].sort(
    (a, b) => b.totalCost - a.totalCost || b.totalTokens - a.totalTokens,
  );
}
