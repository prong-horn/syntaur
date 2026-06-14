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
      totalCost: row.totalCost,
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

/**
 * Full collection pipeline: ingest → rollup → advance the collector heartbeat.
 *
 * `usage_collector_last_run` is a DISTINCT key from `usage_last_collector_run`
 * (the data high-water mark). It records *when the collector ran*, regardless
 * of whether new data arrived.
 *
 * Callers must ensure DB init before calling this function.
 */
export async function collectUsage(): Promise<CollectInfo> {
  const info = await collectAndPersist();
  runRollup();
  advanceMetaIso('usage_collector_last_run', new Date().toISOString());
  return info;
}
