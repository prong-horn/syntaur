import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import {
  initUsageDb,
  closeUsageDb,
  resetUsageDb,
  upsertEvent,
  listDaily,
  getUsageDb,
  type UsageEventInput,
} from '../db/usage-db.js';
import { runRollup } from '../usage/rollup-runner.js';

let sandbox: string;
let dbPath: string;

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'syntaur-rollup-'));
  dbPath = resolve(sandbox, 'syntaur.db');
  resetUsageDb();
});

afterEach(async () => {
  closeUsageDb();
  await rm(sandbox, { recursive: true, force: true });
});

function event(overrides: Partial<UsageEventInput> = {}): UsageEventInput {
  return {
    sessionId: 'sess-1',
    model: 'claude-opus-4-7',
    tool: 'claude',
    eventTs: '2026-05-21T12:00:00.000Z',
    inputTokens: 100,
    outputTokens: 200,
    cacheCreationTokens: 50,
    cacheReadTokens: 1000,
    totalTokens: 1350,
    totalCost: 0.5,
    cwd: '/Users/dev/proj',
    projectSlug: '',
    assignmentSlug: '',
    rawJson: null,
    ...overrides,
  };
}

describe('runRollup', () => {
  it('aggregates events into per-day rows', () => {
    initUsageDb(dbPath);
    upsertEvent(event({ sessionId: 'a', eventTs: '2026-05-21T10:00:00.000Z', totalTokens: 1000, totalCost: 0.1 }));
    upsertEvent(event({ sessionId: 'b', eventTs: '2026-05-21T11:00:00.000Z', totalTokens: 2000, totalCost: 0.2 }));
    upsertEvent(event({ sessionId: 'c', eventTs: '2026-05-22T10:00:00.000Z', totalTokens: 500, totalCost: 0.05 }));

    const r = runRollup();
    expect(r.daysComputed).toBe(2);

    const daily = listDaily();
    const may21 = daily.find((d) => d.day === '2026-05-21');
    const may22 = daily.find((d) => d.day === '2026-05-22');
    expect(may21?.total_tokens).toBe(3000);
    expect(may21?.total_cost).toBeCloseTo(0.3);
    expect(may22?.total_tokens).toBe(500);
  });

  it('is idempotent — running twice produces identical rollup', () => {
    initUsageDb(dbPath);
    upsertEvent(event({ sessionId: 'a', totalTokens: 1000 }));
    upsertEvent(event({ sessionId: 'b', totalTokens: 2000 }));

    runRollup();
    const first = listDaily();
    runRollup();
    const second = listDaily();
    // Strip computed_at (which advances each run) for the comparison.
    const strip = (rows: ReturnType<typeof listDaily>) =>
      rows.map(({ computed_at, ...rest }) => rest);
    expect(strip(first)).toEqual(strip(second));
  });

  it('preserves pre-existing frozen=1 rows across recomputes (v2 forward-compat)', () => {
    initUsageDb(dbPath);
    // Seed a frozen row directly (simulating v2's promotion path).
    getUsageDb()
      .prepare(
        `INSERT INTO usage_daily
           (day, tool, model, project_slug, assignment_slug,
            input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens,
            total_tokens, total_cost, frozen, computed_at)
         VALUES ('2026-05-10', 'claude', 'claude-opus-4-7', '', '', 100, 200, 0, 0, 300, 0.1, 1, '2026-05-11T00:00:00Z')`,
      )
      .run();

    upsertEvent(event({ eventTs: '2026-05-21T12:00:00.000Z' }));
    runRollup();

    const daily = listDaily();
    expect(daily.find((d) => d.day === '2026-05-10')?.frozen).toBe(1);
    expect(daily.find((d) => d.day === '2026-05-21')?.frozen).toBe(0);
  });

  it('cross-UTC-day regression: a growing session does NOT double-count after midnight UPSERT', () => {
    initUsageDb(dbPath);
    // Day 1: session at 100 tokens with event_ts on day 1.
    upsertEvent(event({ sessionId: 'long', totalTokens: 100, eventTs: '2026-05-20T23:50:00.000Z' }));
    runRollup();
    const afterDay1 = listDaily();
    expect(afterDay1.find((d) => d.day === '2026-05-20')?.total_tokens).toBe(100);

    // Day 2: same session UPSERTs to 200 cumulative with event_ts on day 2.
    upsertEvent(event({ sessionId: 'long', totalTokens: 200, eventTs: '2026-05-21T00:30:00.000Z' }));
    runRollup();
    const afterDay2 = listDaily();

    // The total across all days should be exactly 200 (the latest cumulative
    // snapshot), NOT 300 (which would be 100 frozen on day 1 + 200 on day 2).
    const sum = afterDay2.reduce((acc, r) => acc + r.total_tokens, 0);
    expect(sum).toBe(200);

    // Day 1 should have no live (frozen=0) row anymore — the session moved.
    expect(afterDay2.find((d) => d.day === '2026-05-20' && d.frozen === 0)).toBeUndefined();
    expect(afterDay2.find((d) => d.day === '2026-05-21')?.total_tokens).toBe(200);
  });

  it('handles no events gracefully (writes nothing, no error)', () => {
    initUsageDb(dbPath);
    const r = runRollup();
    expect(r.daysComputed).toBe(0);
    expect(r.rowsWritten).toBe(0);
    expect(listDaily()).toHaveLength(0);
  });

  it('groups by attribution dimensions', () => {
    initUsageDb(dbPath);
    upsertEvent(event({ sessionId: 'a', projectSlug: 'p1', assignmentSlug: 'a1', totalTokens: 100 }));
    upsertEvent(event({ sessionId: 'b', projectSlug: 'p1', assignmentSlug: 'a2', totalTokens: 200 }));
    upsertEvent(event({ sessionId: 'c', projectSlug: 'p2', assignmentSlug: 'a1', totalTokens: 300 }));

    runRollup();
    const daily = listDaily();
    expect(daily).toHaveLength(3);
    const p1a1 = daily.find((d) => d.project_slug === 'p1' && d.assignment_slug === 'a1');
    const p1a2 = daily.find((d) => d.project_slug === 'p1' && d.assignment_slug === 'a2');
    const p2a1 = daily.find((d) => d.project_slug === 'p2' && d.assignment_slug === 'a1');
    expect(p1a1?.total_tokens).toBe(100);
    expect(p1a2?.total_tokens).toBe(200);
    expect(p2a1?.total_tokens).toBe(300);
  });
});
