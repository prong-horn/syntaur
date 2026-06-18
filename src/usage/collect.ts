/**
 * collect.ts — reusable collect+rollup sequence.
 *
 * Extracts `collectAndPersist` (raw ingest) and the higher-level
 * `collectUsage` (ingest + rollup + heartbeat) so both the CLI command and
 * dashboard background tasks can share a single implementation.
 *
 * IMPORTANT: Neither function calls initUsageDb()/initSessionDb().  The
 * caller must guarantee DB init before invoking these (the CLI does so in
 * runUsage(); the dashboard does so at startup).
 */

import {
  upsertEvent,
  getMeta,
  advanceMetaIso,
  getUsageDb,
  type UsageEventInput,
} from '../db/usage-db.js';
import { runCcusage, isoToCcusageDate } from './ccusage-collector.js';
import {
  walkClaudeProjects,
  walkCodexSessions,
  walkPiSessions,
  type SessionMeta,
} from './cwd-extractor.js';
import { resolveAttribution } from './session-join.js';
import { runRollup } from './rollup-runner.js';
import { priceForModel } from './pricing.js';

export interface CollectInfo {
  isFirstRun: boolean;
  rowsIngested: number;
}

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

/** Convert `YYYYMMDD` back to `YYYY-MM-DD` for ISO construction. */
function formatDayFromCcusageDate(yyyymmdd: string): string {
  return `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;
}

/**
 * Ingests new ccusage rows, enriches them with cwd/attribution, and persists
 * to the usage DB inside a single transaction.  Advances `usage_last_collector_run`
 * (the data high-water mark) when new rows arrive.
 *
 * Does NOT call rollup or update the heartbeat key — use `collectUsage` for
 * the full pipeline.
 */
export async function collectAndPersist(): Promise<CollectInfo> {
  const lastRunIso = getMeta('usage_last_collector_run');
  const isFirstRun = lastRunIso === null;
  const sinceIso = lastRunIso
    ? lastRunIso
    : new Date(Date.now() - THIRTY_DAYS_MS).toISOString();
  const sinceDate = isoToCcusageDate(sinceIso);

  const result = await runCcusage({ sinceDate });
  if (!result || result.rows.length === 0) {
    // No new data — leave existing DB alone, leave `last_run` unchanged so a
    // future run can re-cover this window.
    return { isFirstRun, rowsIngested: 0 };
  }

  // Use the UTC-day start corresponding to `sinceDate` for the mtime cutoff,
  // not `lastRunIso` exact wall time. This keeps the cwd-walk window aligned
  // with ccusage's day-granular `--since` filter so a same-day re-collect
  // doesn't skip session files whose mtime predates the last run's exact
  // moment but is still within the day ccusage will report (codex-review
  // CRITICAL on attribution erasure).
  const sinceMtimeMs = new Date(`${formatDayFromCcusageDate(sinceDate)}T00:00:00.000Z`).getTime();

  // Build a sessionId → SessionMeta map from the cwd walkers.
  const metaBySession = new Map<string, SessionMeta>();
  for await (const meta of walkClaudeProjects({ sinceMtimeMs })) {
    metaBySession.set(meta.sessionId, meta);
  }
  for await (const meta of walkCodexSessions({ sinceMtimeMs })) {
    metaBySession.set(meta.sessionId, meta);
  }
  for await (const meta of walkPiSessions({ sinceMtimeMs })) {
    metaBySession.set(meta.sessionId, meta);
  }

  // Enrich rows with cwd + attribution.
  const enriched: UsageEventInput[] = result.rows.map((row) => {
    const sessionMeta = metaBySession.get(row.sessionId);
    const cwd = sessionMeta?.cwd ?? null;
    const attr = resolveAttribution({
      sessionId: row.sessionId,
      cwd,
      eventTs: row.eventTs,
    });
    // Cost fallback for models ccusage cannot price (e.g. pi's Synthetic-hosted
    // Kimi models, reported with cost 0). Applied ONLY when upstream cost is 0 —
    // a real ccusage cost is never overwritten. Computed at ingest (not as a
    // post-hoc reprice) so a growing cumulative session carries a larger cost as
    // its tokens grow and `upsertEvent`'s `total_cost = MAX(...)` keeps it current.
    const totalCost =
      row.totalCost > 0
        ? row.totalCost
        : (priceForModel(row.model, {
            inputTokens: row.inputTokens,
            outputTokens: row.outputTokens,
            cacheCreationTokens: row.cacheCreationTokens,
            cacheReadTokens: row.cacheReadTokens,
          }) ?? 0);
    return {
      sessionId: row.sessionId,
      model: row.model,
      tool: row.tool,
      eventTs: row.eventTs,
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      cacheCreationTokens: row.cacheCreationTokens,
      cacheReadTokens: row.cacheReadTokens,
      totalTokens: row.totalTokens,
      totalCost,
      cwd,
      projectSlug: attr.projectSlug ?? '',
      assignmentSlug: attr.assignmentSlug ?? '',
      rawJson: row.rawJson,
    };
  });

  // Persist atomically: all events + last_run advance in one transaction.
  // `advanceMetaIso` is monotonic — an older snapshot can't regress the
  // high-water mark even if two collectors race.
  const db = getUsageDb();
  const tx = db.transaction(() => {
    for (const row of enriched) upsertEvent(row);
    if (result.highWaterMark) {
      advanceMetaIso('usage_last_collector_run', result.highWaterMark);
    }
  });
  tx.immediate();

  return { isFirstRun, rowsIngested: enriched.length };
}

interface ZeroCostRow {
  session_id: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
}

/**
 * Backfill `total_cost` for already-stored rows that ccusage couldn't price
 * (`total_cost = 0`) but for which we now have a fallback rate. These are
 * historical rows that won't be re-collected (so they don't grow) — a direct set
 * is safe. New rows are already priced at ingest in `collectAndPersist`; this
 * catches the pre-existing $0 backlog. Idempotent (a priced row is no longer 0)
 * and self-healing (adding a rate prices previously-unpriceable rows next run).
 * Returns the number of rows updated.
 */
export function backfillZeroCostEvents(): number {
  const db = getUsageDb();
  const select = db.prepare(
    `SELECT session_id, model, input_tokens, output_tokens,
            cache_creation_tokens, cache_read_tokens
       FROM usage_events
      WHERE total_cost = 0`,
  );
  // The UPDATE re-asserts `total_cost = 0`: if a concurrent collector (the
  // dashboard loop overlapping a manual `syntaur usage`) priced or ingested a
  // real cost for the row between read and write, the guard makes this a no-op
  // rather than clobbering it (protecting the "never overwrite a real cost" and
  // growing-session monotonicity invariants). The SELECT runs inside the
  // BEGIN IMMEDIATE transaction below, so read+write are atomic against other
  // writers; the guard is belt-and-suspenders and yields an accurate count.
  const update = db.prepare(
    `UPDATE usage_events SET total_cost = @cost, updated_at = @updatedAt
      WHERE session_id = @sessionId AND model = @model AND total_cost = 0`,
  );
  let updated = 0;
  const tx = db.transaction(() => {
    const updatedAt = new Date().toISOString();
    for (const r of select.all() as ZeroCostRow[]) {
      const cost = priceForModel(r.model, {
        inputTokens: r.input_tokens,
        outputTokens: r.output_tokens,
        cacheCreationTokens: r.cache_creation_tokens,
        cacheReadTokens: r.cache_read_tokens,
      });
      if (cost !== null && cost > 0) {
        updated += update.run({ cost, updatedAt, sessionId: r.session_id, model: r.model }).changes;
      }
    }
  });
  tx.immediate();
  return updated;
}

interface OrphanRow {
  session_id: string;
  model: string;
  cwd: string | null;
  event_ts: string;
}

/**
 * Re-attribute usage rows still in the unattributed bucket (empty project AND
 * empty assignment). Once a session is registered (e.g. the pi sessions
 * descriptor now backfills pi sessions), `resolveAttribution`'s Stage-1 PK match
 * succeeds for rows whose session was previously unknown — repairing pi usage
 * that was orphaned before its session existed. Uses the row's stored `cwd`.
 * Returns the number of rows updated.
 */
export function reattributeOrphanEvents(): number {
  const db = getUsageDb();
  const select = db.prepare(
    `SELECT session_id, model, cwd, event_ts
       FROM usage_events
      WHERE project_slug = '' AND assignment_slug = ''`,
  );
  // The UPDATE re-asserts the empty-attribution state: a concurrent collector
  // that attributed the row between read and write must not be overwritten. The
  // SELECT runs inside the BEGIN IMMEDIATE transaction below (atomic against
  // other writers); the guard is belt-and-suspenders and yields an accurate count.
  const update = db.prepare(
    `UPDATE usage_events
        SET project_slug = @projectSlug, assignment_slug = @assignmentSlug, updated_at = @updatedAt
      WHERE session_id = @sessionId AND model = @model
        AND project_slug = '' AND assignment_slug = ''`,
  );
  let updated = 0;
  const tx = db.transaction(() => {
    const updatedAt = new Date().toISOString();
    for (const r of select.all() as OrphanRow[]) {
      const attr = resolveAttribution({
        sessionId: r.session_id,
        cwd: r.cwd,
        eventTs: r.event_ts,
      });
      const projectSlug = attr.projectSlug ?? '';
      const assignmentSlug = attr.assignmentSlug ?? '';
      if (projectSlug !== '' || assignmentSlug !== '') {
        updated += update
          .run({ projectSlug, assignmentSlug, updatedAt, sessionId: r.session_id, model: r.model })
          .changes;
      }
    }
  });
  tx.immediate();
  return updated;
}

/**
 * Full collection pipeline: ingest → backfill/repair → rollup → advance the
 * collector heartbeat.
 *
 * `backfillZeroCostEvents` and `reattributeOrphanEvents` run UNCONDITIONALLY
 * before the rollup — even when `collectAndPersist` early-returns on no new
 * ccusage data — so historical $0 rows get priced and historical orphans get
 * attributed regardless of whether fresh usage arrived. The rollup recomputes
 * `usage_daily` from `usage_events`, so both repairs propagate to the dashboard.
 *
 * `usage_collector_heartbeat` is a DISTINCT key from `usage_last_collector_run`
 * (the data high-water mark). It records *when the collector ran*, regardless
 * of whether new data arrived.
 *
 * Callers must ensure DB init before calling this function.
 */
export async function collectUsage(): Promise<CollectInfo> {
  const info = await collectAndPersist();
  backfillZeroCostEvents();
  reattributeOrphanEvents();
  runRollup();
  advanceMetaIso('usage_collector_heartbeat', new Date().toISOString());
  return info;
}
