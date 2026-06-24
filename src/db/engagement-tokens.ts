/**
 * Token-snapshot seam for engagement cost-per-stage.
 *
 * Per-stage cost (a FUTURE assignment) = tokens_at_close − tokens_at_open for an
 * engagement. This module only handles **capture**: it produces a `TokenSnapshot`
 * — a per-model cumulative map plus provenance — that callers snapshot ONCE at a
 * stage/assignment transition and store verbatim in `engagement.tokens_at_open`/
 * `tokens_at_close`. See decision-record.md Decision 2.
 *
 * Design choices (Decision 2, finalized):
 *   - The source is **async** (`=> Promise<TokenSnapshot>`) because the only way
 *     to refresh cumulative tokens is the ccusage collector, which spawns a child
 *     process — and you cannot `await` inside a synchronous better-sqlite3
 *     transaction. So the caller resolves the snapshot BEFORE opening the
 *     (synchronous) switch transaction and passes the value in.
 *   - The baseline production source does a point-in-time read of `usage_events`
 *     and stamps `collectorRunAt` (the `usage_last_collector_run` it reflects) +
 *     `capturedAt`. Freshness is best-effort: we do NOT force a collector
 *     subprocess on the switch hot path. Reporting is deferred, over-attribution
 *     is prevented by capture-once-never-re-read, and provenance lets a future
 *     report discount/refresh low-confidence boundaries.
 *   - The source is injectable for tests.
 */

import { getSessionDb } from '../dashboard/session-db.js';

export interface ModelTokens {
  input: number;
  output: number;
  cacheCreation: number;
  cacheRead: number;
  total: number;
  cost: number;
}

export interface TokenSnapshot {
  /** Per-model cumulative totals for the session at capture time. */
  models: Record<string, ModelTokens>;
  /** The `usage_last_collector_run` the values reflect (provenance), or null. */
  collectorRunAt: string | null;
  /** When this snapshot was taken (ISO 8601). */
  capturedAt: string;
}

export type CumulativeTokenSource = (sessionId: string) => Promise<TokenSnapshot>;

export function serializeSnapshot(snapshot: TokenSnapshot | null): string | null {
  return snapshot === null ? null : JSON.stringify(snapshot);
}

export function parseSnapshot(json: string | null): TokenSnapshot | null {
  return json === null ? null : (JSON.parse(json) as TokenSnapshot);
}

/** True if a table exists on the shared connection (usage_events may be absent
 * in a process that never initialized the usage DB). */
function tableExists(name: string): boolean {
  const row = getSessionDb()
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name);
  return row !== undefined;
}

interface UsageAggRow {
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  total_tokens: number;
  total_cost: number;
}

/**
 * Baseline production source: read the per-model cumulative totals for the
 * session from `usage_events` (point-in-time), stamped with collector-run
 * provenance. No collector subprocess is spawned here.
 */
export const productionCumulativeTokenSource: CumulativeTokenSource = async (
  sessionId,
) => {
  const capturedAt = new Date().toISOString();
  const db = getSessionDb();

  const collectorRow = db
    .prepare("SELECT value FROM meta WHERE key = 'usage_last_collector_run'")
    .get() as { value: string } | undefined;
  const collectorRunAt = collectorRow?.value ?? null;

  const models: Record<string, ModelTokens> = {};
  if (tableExists('usage_events')) {
    const rows = db
      .prepare(
        `SELECT model, input_tokens, output_tokens, cache_creation_tokens,
                cache_read_tokens, total_tokens, total_cost
           FROM usage_events
          WHERE session_id = ?`,
      )
      .all(sessionId) as UsageAggRow[];
    for (const r of rows) {
      models[r.model] = {
        input: r.input_tokens,
        output: r.output_tokens,
        cacheCreation: r.cache_creation_tokens,
        cacheRead: r.cache_read_tokens,
        total: r.total_tokens,
        cost: r.total_cost,
      };
    }
  }

  return { models, collectorRunAt, capturedAt };
};

let override: CumulativeTokenSource | null = null;

/** Inject a token source (tests). Pass `null` to restore the production source. */
export function setCumulativeTokenSource(src: CumulativeTokenSource | null): void {
  override = src;
}

/** The active token source — the injected override, else the production source. */
export function getCumulativeTokenSource(): CumulativeTokenSource {
  return override ?? productionCumulativeTokenSource;
}
