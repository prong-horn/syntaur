import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import {
  initSessionDb,
  closeSessionDb,
  resetSessionDb,
} from '../dashboard/session-db.js';
import {
  initUsageDb,
  closeUsageDb,
  resetUsageDb,
  upsertEvent,
  setMeta,
} from '../db/usage-db.js';
import {
  serializeSnapshot,
  parseSnapshot,
  setCumulativeTokenSource,
  getCumulativeTokenSource,
  type TokenSnapshot,
} from '../db/engagement-tokens.js';

let testDir: string;
let dbPath: string;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'syntaur-tok-test-'));
  dbPath = resolve(testDir, 'test.db');
  resetSessionDb();
  resetUsageDb();
  initSessionDb(dbPath);
  initUsageDb(dbPath);
});

afterEach(async () => {
  setCumulativeTokenSource(null);
  closeSessionDb();
  closeUsageDb();
  await rm(testDir, { recursive: true, force: true });
});

const sample: TokenSnapshot = {
  models: {
    m1: { input: 1, output: 2, cacheCreation: 3, cacheRead: 4, total: 10, cost: 0.5 },
  },
  collectorRunAt: '2026-03-26T09:00:00.000Z',
  capturedAt: '2026-03-26T10:00:00.000Z',
};

describe('snapshot serialization', () => {
  it('round-trips through JSON', () => {
    const json = serializeSnapshot(sample);
    expect(parseSnapshot(json)).toEqual(sample);
  });
  it('handles null', () => {
    expect(serializeSnapshot(null)).toBeNull();
    expect(parseSnapshot(null)).toBeNull();
  });
});

describe('injectable token source', () => {
  it('uses the injected source over the production default', async () => {
    setCumulativeTokenSource(async () => sample);
    const got = await getCumulativeTokenSource()('any-session');
    expect(got).toEqual(sample);
  });
});

describe('production cumulative source', () => {
  it('sums per-model cumulative from usage_events and stamps collector-run provenance', async () => {
    setMeta('usage_last_collector_run', '2026-03-26T08:00:00.000Z');
    const base = {
      tool: 'claude',
      eventTs: '2026-03-26T07:00:00.000Z',
      cwd: null,
      projectSlug: '',
      assignmentSlug: '',
      rawJson: null,
    };
    upsertEvent({
      sessionId: 's1',
      model: 'opus',
      inputTokens: 100,
      outputTokens: 50,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      totalTokens: 150,
      totalCost: 1.5,
      ...base,
    });
    upsertEvent({
      sessionId: 's1',
      model: 'haiku',
      inputTokens: 10,
      outputTokens: 5,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      totalTokens: 15,
      totalCost: 0.1,
      ...base,
    });
    // a different session's tokens must not leak in
    upsertEvent({
      sessionId: 's2',
      model: 'opus',
      inputTokens: 999,
      outputTokens: 999,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      totalTokens: 1998,
      totalCost: 9,
      ...base,
    });

    const snapshot = await getCumulativeTokenSource()('s1');
    expect(Object.keys(snapshot.models).sort()).toEqual(['haiku', 'opus']);
    expect(snapshot.models.opus.total).toBe(150);
    expect(snapshot.models.haiku.total).toBe(15);
    expect(snapshot.collectorRunAt).toBe('2026-03-26T08:00:00.000Z');
    expect(typeof snapshot.capturedAt).toBe('string');
    expect(snapshot.capturedAt.length).toBeGreaterThan(0);
  });

  it('returns an empty model map for an unknown session', async () => {
    const snapshot = await getCumulativeTokenSource()('nope');
    expect(snapshot.models).toEqual({});
  });
});
