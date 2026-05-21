/**
 * Daily rollup runner (v1: recompute-from-scratch).
 *
 * Aggregates `usage_events` into `usage_daily`, grouped by
 * `(date(event_ts), tool, model, project_slug, assignment_slug)`. Inside one
 * `BEGIN IMMEDIATE` transaction:
 *   1. DELETE all `frozen = 0` rows (v1 always writes frozen=0).
 *   2. INSERT current aggregates.
 *
 * Pre-existing `frozen = 1` rows survive — v2 will populate them via the
 * closed-session promotion path; v1 leaves the door open without writing
 * them.
 *
 * `decision-record.md` Decision 4 explains why v1 drops freeze: a session
 * that grows tokens across UTC midnight + a naive "freeze yesterday once"
 * runner would double-count its tokens. Recomputing from scratch eliminates
 * that class entirely at the cost of log-rotation resilience (which v2
 * solves by tracking closed-session totals separately).
 */

import { getUsageDb, nowIso } from '../db/usage-db.js';

export interface RollupResult {
  daysComputed: number;
  rowsWritten: number;
}

/**
 * Recompute `usage_daily` from `usage_events` in v1's recompute-from-scratch
 * model. The SELECT, DELETE, and INSERT happen inside a single
 * `BEGIN IMMEDIATE` transaction so a concurrent collector or rollup can't
 * interleave and stamp stale totals over fresher ones (codex-review HIGH).
 */
export function runRollup(): RollupResult {
  const database = getUsageDb();

  let daysComputed = 0;
  let rowsWritten = 0;

  const tx = database.transaction(() => {
    const rows = database
      .prepare(
        `SELECT date(event_ts)                AS day,
                tool,
                model,
                project_slug,
                assignment_slug,
                SUM(input_tokens)             AS input_tokens,
                SUM(output_tokens)            AS output_tokens,
                SUM(cache_creation_tokens)    AS cache_creation_tokens,
                SUM(cache_read_tokens)        AS cache_read_tokens,
                SUM(total_tokens)             AS total_tokens,
                SUM(total_cost)               AS total_cost
           FROM usage_events
          GROUP BY 1, 2, 3, 4, 5`,
      )
      .all() as Array<{
      day: string;
      tool: string;
      model: string;
      project_slug: string;
      assignment_slug: string;
      input_tokens: number;
      output_tokens: number;
      cache_creation_tokens: number;
      cache_read_tokens: number;
      total_tokens: number;
      total_cost: number;
    }>;

    database.prepare('DELETE FROM usage_daily WHERE frozen = 0').run();

    const insert = database.prepare(
      `INSERT INTO usage_daily (
         day, tool, model, project_slug, assignment_slug,
         input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens,
         total_tokens, total_cost, frozen, computed_at
       ) VALUES (
         @day, @tool, @model, @projectSlug, @assignmentSlug,
         @inputTokens, @outputTokens, @cacheCreationTokens, @cacheReadTokens,
         @totalTokens, @totalCost, 0, @computedAt
       )`,
    );

    const computedAt = nowIso();
    const distinctDays = new Set<string>();
    for (const r of rows) {
      insert.run({
        day: r.day,
        tool: r.tool,
        model: r.model,
        projectSlug: r.project_slug,
        assignmentSlug: r.assignment_slug,
        inputTokens: r.input_tokens,
        outputTokens: r.output_tokens,
        cacheCreationTokens: r.cache_creation_tokens,
        cacheReadTokens: r.cache_read_tokens,
        totalTokens: r.total_tokens,
        totalCost: r.total_cost,
        computedAt,
      });
      distinctDays.add(r.day);
    }

    daysComputed = distinctDays.size;
    rowsWritten = rows.length;
  });

  tx.immediate();
  return { daysComputed, rowsWritten };
}
