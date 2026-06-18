import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import {
  initUsageDb,
  closeUsageDb,
  resetUsageDb,
  upsertEvent,
  listEvents,
  type UsageEventInput,
} from '../db/usage-db.js';
import { initSessionDb, closeSessionDb, resetSessionDb } from '../dashboard/session-db.js';
import { appendSession } from '../dashboard/agent-sessions.js';
import { priceForModel } from '../usage/pricing.js';
import { backfillZeroCostEvents, reattributeOrphanEvents } from '../usage/collect.js';

let testDir: string;

const PI_MODEL = '[pi] hf:moonshotai/Kimi-K2.6';

function makeEvent(overrides: Partial<UsageEventInput> = {}): UsageEventInput {
  return {
    sessionId: 'pi-sess-1',
    model: PI_MODEL,
    tool: 'pi',
    eventTs: '2026-06-11T12:00:00.000Z',
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 1_000_000,
    totalTokens: 1_000_000,
    totalCost: 0,
    cwd: '/Users/dev/proj',
    projectSlug: '',
    assignmentSlug: '',
    rawJson: null,
    ...overrides,
  };
}

function rowFor(sessionId: string, model: string) {
  return listEvents().find((e) => e.session_id === sessionId && e.model === model)!;
}

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'syntaur-collect-repair-'));
  resetUsageDb();
  resetSessionDb();
  initUsageDb(resolve(testDir, 'usage.db'));
  initSessionDb(resolve(testDir, 'sessions.db'));
});

afterEach(async () => {
  closeUsageDb();
  closeSessionDb();
  await rm(testDir, { recursive: true, force: true });
});

describe('ingest pricing + MAX upsert (growing cumulative session)', () => {
  it("a growing pi session's cost increases with its tokens (not frozen)", () => {
    // Mirror collectAndPersist: price at ingest, upsert. ccusage reports
    // cumulative per-session usage, so a later snapshot has MORE tokens.
    const buckets1 = { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 1_000_000 };
    upsertEvent(makeEvent({ ...buckets1, totalCost: priceForModel(PI_MODEL, buckets1)! }));
    const cost1 = rowFor('pi-sess-1', PI_MODEL).total_cost;
    expect(cost1).toBeCloseTo(0.16, 10);

    const buckets2 = { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 2_000_000 };
    upsertEvent(makeEvent({ ...buckets2, totalTokens: 2_000_000, totalCost: priceForModel(PI_MODEL, buckets2)! }));
    const cost2 = rowFor('pi-sess-1', PI_MODEL).total_cost;
    expect(cost2).toBeCloseTo(0.32, 10); // grew with the tokens; MAX kept the larger value
    expect(cost2).toBeGreaterThan(cost1);
  });
});

describe('backfillZeroCostEvents', () => {
  it('prices a historical $0 pi row whose model has a known rate', () => {
    upsertEvent(makeEvent()); // total_cost 0, 1M cacheRead
    const updated = backfillZeroCostEvents();
    expect(updated).toBe(1);
    expect(rowFor('pi-sess-1', PI_MODEL).total_cost).toBeCloseTo(0.16, 10);
  });

  it('leaves a $0 row for an unknown/known-priced model untouched (no inflation)', () => {
    // A claude row with total_cost 0 must stay 0 — claude is not in MODEL_PRICING.
    upsertEvent(makeEvent({ sessionId: 'c-1', model: 'claude-opus-4-8', tool: 'claude', totalCost: 0 }));
    backfillZeroCostEvents();
    expect(rowFor('c-1', 'claude-opus-4-8').total_cost).toBe(0);
  });

  it('is idempotent — a second run updates nothing', () => {
    upsertEvent(makeEvent());
    expect(backfillZeroCostEvents()).toBe(1);
    expect(backfillZeroCostEvents()).toBe(0);
    expect(rowFor('pi-sess-1', PI_MODEL).total_cost).toBeCloseTo(0.16, 10);
  });

  it('never overwrites a real upstream cost (>0)', () => {
    upsertEvent(makeEvent({ sessionId: 'real-1', totalCost: 7.5 }));
    backfillZeroCostEvents();
    expect(rowFor('real-1', PI_MODEL).total_cost).toBe(7.5);
  });
});

describe('reattributeOrphanEvents', () => {
  it('attributes an orphaned row once its session is registered', async () => {
    await appendSession('', {
      projectSlug: 'proj-x',
      assignmentSlug: 'assn-y',
      agent: 'pi',
      sessionId: 'pi-sess-1',
      started: '2026-06-11T08:00:00.000Z',
      status: 'active',
      path: '/Users/dev/proj',
    });
    upsertEvent(makeEvent()); // empty attribution

    const updated = reattributeOrphanEvents();
    expect(updated).toBe(1);
    const row = rowFor('pi-sess-1', PI_MODEL);
    expect(row.project_slug).toBe('proj-x');
    expect(row.assignment_slug).toBe('assn-y');
  });

  it('leaves a row whose session is still unknown untouched', () => {
    upsertEvent(makeEvent({ sessionId: 'never-registered', cwd: null }));
    expect(reattributeOrphanEvents()).toBe(0);
    const row = rowFor('never-registered', PI_MODEL);
    expect(row.project_slug).toBe('');
    expect(row.assignment_slug).toBe('');
  });
});
