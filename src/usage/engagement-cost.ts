/**
 * Per-window / per-assignment cost from engagement SNAPSHOT deltas — the source
 * of truth for assignment cost attribution (decision-record.md Decision 1/3).
 *
 * `usage_events` is cumulative per `(session_id, model)` with a date-only
 * session-level `event_ts`, so it CANNOT split one session's cost across two
 * assignments it worked in sequence. Each engagement instead snapshots the
 * session's cumulative per-model cost at open and close (`tokens_at_open` /
 * `tokens_at_close`); a window's cost is the per-model `cost` DELTA between them.
 * Summing windows per assignment attributes each window to the right assignment
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

export interface AssignmentWindowCostOpts {
  /** Preferred match key — the engagement's `assignment_id`, when known. */
  assignmentId?: string | null;
  /** Fallback match: project-nested slug; empty/null ⇒ standalone (NULL match). */
  projectSlug?: string | null;
  /** Fallback match: the assignment slug. Required when `assignmentId` is absent. */
  assignmentSlug?: string | null;
  /** Inclusive `since` (YYYY-MM-DD) — filters windows by `ended_at`. */
  since?: string;
  /** Inclusive `until` (YYYY-MM-DD) — filters windows by `ended_at`. */
  until?: string;
  /** Restrict the per-model delta sum to this single model. */
  model?: string;
}

export interface ProjectWindowCostsOpts {
  projectSlug: string;
  since?: string;
  until?: string;
  model?: string;
}

export interface AssignmentWindowCost extends WindowCostResult {
  assignmentSlug: string;
  assignmentId: string | null;
}

interface EngagementCostRow {
  assignment_id: string | null;
  assignment_slug: string | null;
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
 * Per-assignment cost from its closed engagement windows. Matches by
 * `assignment_id` when supplied, else by `(project_slug, assignment_slug)` —
 * standalone (`projectSlug` empty/null) matches `project_slug IS NULL`.
 */
export function assignmentWindowCost(opts: AssignmentWindowCostOpts): WindowCostResult {
  const db = engagementDb();
  if (!db) return { ...EMPTY };
  const clauses = ['ended_at IS NOT NULL'];
  const params: unknown[] = [];

  if (opts.assignmentId) {
    clauses.push('assignment_id = ?');
    params.push(opts.assignmentId);
  } else {
    const proj = opts.projectSlug && opts.projectSlug.length > 0 ? opts.projectSlug : null;
    if (proj === null) {
      clauses.push('project_slug IS NULL');
    } else {
      clauses.push('project_slug = ?');
      params.push(proj);
    }
    clauses.push('assignment_slug = ?');
    params.push(opts.assignmentSlug ?? null);
  }

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
      `SELECT assignment_id, assignment_slug, tokens_at_open, tokens_at_close
         FROM engagement
        WHERE ${clauses.join(' AND ')}`,
    )
    .all(...params) as EngagementCostRow[];
  return rollupWindows(rows, opts.model);
}

/**
 * Per-assignment cost for EVERY assignment that has at least one closed
 * engagement window in the project, keyed by `assignment_slug`. The project
 * rollup endpoint unions these keys with its `usage_daily` keys so an assignment
 * with a snapshot window but no `usage_daily` row (the A-then-B cumulative-row
 * case) still appears with its cost.
 */
export function projectWindowCosts(
  opts: ProjectWindowCostsOpts,
): Map<string, AssignmentWindowCost> {
  const db = engagementDb();
  if (!db) return new Map();
  const clauses = ['ended_at IS NOT NULL', 'project_slug = ?', 'assignment_slug IS NOT NULL'];
  const params: unknown[] = [opts.projectSlug];
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
      `SELECT assignment_id, assignment_slug, tokens_at_open, tokens_at_close
         FROM engagement
        WHERE ${clauses.join(' AND ')}`,
    )
    .all(...params) as EngagementCostRow[];

  const grouped = new Map<string, EngagementCostRow[]>();
  const idForSlug = new Map<string, string | null>();
  for (const row of rows) {
    const slug = row.assignment_slug as string; // non-null by the WHERE clause
    const bucket = grouped.get(slug);
    if (bucket) bucket.push(row);
    else grouped.set(slug, [row]);
    if (row.assignment_id && !idForSlug.get(slug)) idForSlug.set(slug, row.assignment_id);
  }

  const out = new Map<string, AssignmentWindowCost>();
  for (const [slug, bucket] of grouped) {
    out.set(slug, {
      assignmentSlug: slug,
      assignmentId: idForSlug.get(slug) ?? null,
      ...rollupWindows(bucket, opts.model),
    });
  }
  return out;
}
