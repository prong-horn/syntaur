import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import {
  initUsageDb,
  getUsageDb,
  closeUsageDb,
  resetUsageDb,
  upsertEvent,
  listEvents,
  insertDailyBatch,
  listDaily,
  listDistinctModels,
  listDistinctTools,
  getMeta,
  setMeta,
  advanceMetaIso,
  type UsageEventInput,
  type UsageDailyInput,
} from '../db/usage-db.js';

let testDir: string;
let dbPath: string;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'syntaur-usage-db-test-'));
  dbPath = resolve(testDir, 'syntaur.db');
  resetUsageDb();
});

afterEach(async () => {
  closeUsageDb();
  await rm(testDir, { recursive: true, force: true });
});

function makeEvent(overrides: Partial<UsageEventInput> = {}): UsageEventInput {
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

function makeDaily(overrides: Partial<UsageDailyInput> = {}): UsageDailyInput {
  return {
    day: '2026-05-21',
    tool: 'claude',
    model: 'claude-opus-4-7',
    projectSlug: '',
    assignmentSlug: '',
    inputTokens: 100,
    outputTokens: 200,
    cacheCreationTokens: 50,
    cacheReadTokens: 1000,
    totalTokens: 1350,
    totalCost: 0.5,
    ...overrides,
  };
}

describe('initUsageDb', () => {
  it('creates the schema and seeds usage_schema_version', () => {
    const db = initUsageDb(dbPath);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as Array<{ name: string }>;
    const names = tables.map((t) => t.name);
    expect(names).toContain('meta');
    expect(names).toContain('usage_events');
    expect(names).toContain('usage_daily');

    const version = db
      .prepare("SELECT value FROM meta WHERE key = 'usage_schema_version'")
      .get() as { value: string } | undefined;
    expect(version?.value).toBe('1');
  });

  it('is idempotent on repeat init calls', () => {
    const a = initUsageDb(dbPath);
    const b = initUsageDb(dbPath);
    expect(a).toBe(b);
  });

  it('enables WAL and foreign_keys', () => {
    const db = initUsageDb(dbPath);
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
  });
});

describe('getUsageDb', () => {
  it('throws before init', () => {
    expect(() => getUsageDb()).toThrow(/not initialized/);
  });
});

describe('upsertEvent', () => {
  it('inserts a new row', () => {
    initUsageDb(dbPath);
    upsertEvent(makeEvent());
    const rows = listEvents();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      session_id: 'sess-1',
      model: 'claude-opus-4-7',
      tool: 'claude',
      total_tokens: 1350,
    });
  });

  it('UPSERTs in place on (session_id, model) conflict — refreshes growing totals', () => {
    initUsageDb(dbPath);
    upsertEvent(makeEvent({ totalTokens: 1000, totalCost: 0.1 }));
    upsertEvent(makeEvent({ totalTokens: 5000, totalCost: 0.5 }));
    const rows = listEvents();
    expect(rows).toHaveLength(1);
    expect(rows[0].total_tokens).toBe(5000);
    expect(rows[0].total_cost).toBeCloseTo(0.5);
  });

  it('creates separate rows per model for the same session', () => {
    initUsageDb(dbPath);
    upsertEvent(makeEvent({ model: 'claude-opus-4-7', totalTokens: 1000 }));
    upsertEvent(makeEvent({ model: 'claude-haiku-4-5-20251001', totalTokens: 500 }));
    const rows = listEvents();
    expect(rows).toHaveLength(2);
    const total = rows.reduce((acc, r) => acc + r.total_tokens, 0);
    expect(total).toBe(1500);
  });

  it('filters by since/until and attribution', () => {
    initUsageDb(dbPath);
    upsertEvent(makeEvent({ sessionId: 'a', eventTs: '2026-05-20T00:00:00.000Z', projectSlug: 'p1' }));
    upsertEvent(makeEvent({ sessionId: 'b', eventTs: '2026-05-22T00:00:00.000Z', projectSlug: 'p2' }));
    expect(listEvents({ since: '2026-05-21T00:00:00.000Z' })).toHaveLength(1);
    expect(listEvents({ until: '2026-05-21T00:00:00.000Z' })).toHaveLength(1);
    expect(listEvents({ projectSlug: 'p1' })).toHaveLength(1);
    expect(listEvents({ projectSlug: '' })).toHaveLength(0);
  });
});

describe('insertDailyBatch', () => {
  it('inserts rows', () => {
    initUsageDb(dbPath);
    insertDailyBatch([makeDaily()]);
    const rows = listDaily();
    expect(rows).toHaveLength(1);
    expect(rows[0].total_tokens).toBe(1350);
    expect(rows[0].frozen).toBe(0);
  });

  it('atomically replaces all frozen=0 rows on re-run', () => {
    initUsageDb(dbPath);
    insertDailyBatch([
      makeDaily({ day: '2026-05-20', totalTokens: 100 }),
      makeDaily({ day: '2026-05-21', totalTokens: 200 }),
    ]);
    insertDailyBatch([makeDaily({ day: '2026-05-21', totalTokens: 500 })]);
    const rows = listDaily();
    expect(rows).toHaveLength(1);
    expect(rows[0].day).toBe('2026-05-21');
    expect(rows[0].total_tokens).toBe(500);
  });

  it('preserves pre-existing frozen=1 rows across recomputes (v2 forward-compat)', () => {
    initUsageDb(dbPath);
    insertDailyBatch([makeDaily({ day: '2026-05-20' })]);
    // Manually flip the row to frozen=1 (simulating v2's promotion).
    getUsageDb()
      .prepare('UPDATE usage_daily SET frozen = 1 WHERE day = ?')
      .run('2026-05-20');

    insertDailyBatch([makeDaily({ day: '2026-05-21', totalTokens: 999 })]);

    const rows = listDaily();
    expect(rows).toHaveLength(2);
    const frozen = rows.find((r) => r.day === '2026-05-20');
    const live = rows.find((r) => r.day === '2026-05-21');
    expect(frozen?.frozen).toBe(1);
    expect(live?.total_tokens).toBe(999);
  });

  it('is idempotent for identical input', () => {
    initUsageDb(dbPath);
    const batch = [makeDaily({ day: '2026-05-21', totalTokens: 500 })];
    insertDailyBatch(batch);
    insertDailyBatch(batch);
    const rows = listDaily();
    expect(rows).toHaveLength(1);
    expect(rows[0].total_tokens).toBe(500);
  });

  it('filters by since/until/projectSlug', () => {
    initUsageDb(dbPath);
    insertDailyBatch([
      makeDaily({ day: '2026-05-19', projectSlug: 'p1' }),
      makeDaily({ day: '2026-05-21', projectSlug: 'p2' }),
    ]);
    expect(listDaily({ since: '2026-05-20' })).toHaveLength(1);
    expect(listDaily({ until: '2026-05-20' })).toHaveLength(1);
    expect(listDaily({ projectSlug: 'p1' })).toHaveLength(1);
  });
});

describe('getMeta / setMeta', () => {
  it('round-trips', () => {
    initUsageDb(dbPath);
    expect(getMeta('usage_last_collector_run')).toBeNull();
    setMeta('usage_last_collector_run', '2026-05-21T15:00:00.000Z');
    expect(getMeta('usage_last_collector_run')).toBe('2026-05-21T15:00:00.000Z');
    setMeta('usage_last_collector_run', '2026-05-22T15:00:00.000Z');
    expect(getMeta('usage_last_collector_run')).toBe('2026-05-22T15:00:00.000Z');
  });
});

describe('advanceMetaIso (monotonic)', () => {
  it('writes when no prior value', () => {
    initUsageDb(dbPath);
    const advanced = advanceMetaIso('usage_last_collector_run', '2026-05-21T12:00:00.000Z');
    expect(advanced).toBe(true);
    expect(getMeta('usage_last_collector_run')).toBe('2026-05-21T12:00:00.000Z');
  });

  it('advances on newer value', () => {
    initUsageDb(dbPath);
    advanceMetaIso('usage_last_collector_run', '2026-05-21T12:00:00.000Z');
    const advanced = advanceMetaIso('usage_last_collector_run', '2026-05-21T13:00:00.000Z');
    expect(advanced).toBe(true);
    expect(getMeta('usage_last_collector_run')).toBe('2026-05-21T13:00:00.000Z');
  });

  it('refuses regression — older value cannot overwrite newer', () => {
    initUsageDb(dbPath);
    advanceMetaIso('usage_last_collector_run', '2026-05-21T15:00:00.000Z');
    const advanced = advanceMetaIso('usage_last_collector_run', '2026-05-21T12:00:00.000Z');
    expect(advanced).toBe(false);
    expect(getMeta('usage_last_collector_run')).toBe('2026-05-21T15:00:00.000Z');
  });
});

describe('upsertEvent monotonic guards (codex-review CRITICAL/HIGH fixes)', () => {
  it('preserves attribution when later UPSERT has none', () => {
    initUsageDb(dbPath);
    upsertEvent(makeEvent({ projectSlug: 'p1', assignmentSlug: 'a1', cwd: '/proj' }));
    // A later collect that couldn't attribute (cwd walk missed the JSONL) sends
    // the same session+model but with empty attribution. Existing attribution
    // must survive.
    upsertEvent(
      makeEvent({
        projectSlug: '',
        assignmentSlug: '',
        cwd: null,
        totalTokens: 9999,
        eventTs: '2026-05-21T13:00:00.000Z',
      }),
    );
    const rows = listEvents();
    expect(rows[0].project_slug).toBe('p1');
    expect(rows[0].assignment_slug).toBe('a1');
    expect(rows[0].cwd).toBe('/proj');
    // Token totals DO advance since event_ts is newer.
    expect(rows[0].total_tokens).toBe(9999);
  });

  it('overwrites attribution when later UPSERT has fresher attribution', () => {
    initUsageDb(dbPath);
    upsertEvent(makeEvent({ projectSlug: '', assignmentSlug: '', cwd: null }));
    upsertEvent(
      makeEvent({
        projectSlug: 'newproj',
        assignmentSlug: 'newasgn',
        cwd: '/Users/dev/newproj',
        eventTs: '2026-05-21T13:00:00.000Z',
      }),
    );
    const rows = listEvents();
    expect(rows[0].project_slug).toBe('newproj');
    expect(rows[0].assignment_slug).toBe('newasgn');
    expect(rows[0].cwd).toBe('/Users/dev/newproj');
  });

  it('refuses to regress token counts when event_ts is older', () => {
    initUsageDb(dbPath);
    upsertEvent(makeEvent({ totalTokens: 5000, eventTs: '2026-05-21T15:00:00.000Z' }));
    // A delayed collector commits its result AFTER a fresher snapshot landed.
    upsertEvent(makeEvent({ totalTokens: 1000, eventTs: '2026-05-21T12:00:00.000Z' }));
    const rows = listEvents();
    expect(rows[0].total_tokens).toBe(5000);
    expect(rows[0].event_ts).toBe('2026-05-21T15:00:00.000Z');
  });

  it('takes MAX on token columns even when event_ts is identical (same-day Claude lastActivity)', () => {
    initUsageDb(dbPath);
    // Both events share the same date-only timestamp, which is what Claude
    // sessions look like (ccusage reports YYYY-MM-DD → midnight UTC). The
    // SMALLER cumulative snapshot must NOT regress the larger one even though
    // event_ts is equal.
    const sameTs = '2026-05-21T00:00:00.000Z';
    upsertEvent(makeEvent({ totalTokens: 5000, totalCost: 1.0, eventTs: sameTs }));
    upsertEvent(makeEvent({ totalTokens: 2000, totalCost: 0.4, eventTs: sameTs }));
    const rows = listEvents();
    expect(rows[0].total_tokens).toBe(5000);
    expect(rows[0].total_cost).toBeCloseTo(1.0);
  });

  it('takes MAX even when the larger arrives second (growing session refresh)', () => {
    initUsageDb(dbPath);
    const sameTs = '2026-05-21T00:00:00.000Z';
    upsertEvent(makeEvent({ totalTokens: 1000, totalCost: 0.2, eventTs: sameTs }));
    upsertEvent(makeEvent({ totalTokens: 7000, totalCost: 1.4, eventTs: sameTs }));
    const rows = listEvents();
    expect(rows[0].total_tokens).toBe(7000);
    expect(rows[0].total_cost).toBeCloseTo(1.4);
  });
});

describe('listDaily model filter', () => {
  it('filters by model and composes with since', () => {
    initUsageDb(dbPath);
    insertDailyBatch([
      makeDaily({ model: 'opus', day: '2026-05-19' }),
      makeDaily({ model: 'sonnet', day: '2026-05-21' }),
      makeDaily({ model: 'opus', day: '2026-05-21' }),
    ]);
    expect(listDaily({ model: 'opus' }).length).toBe(2);
    expect(listDaily({ model: 'sonnet' }).length).toBe(1);
    expect(listDaily({ model: 'opus', since: '2026-05-20' }).length).toBe(1);
  });
});

describe('listDaily / listEvents workspaceMembers filter', () => {
  function seedDaily() {
    insertDailyBatch([
      makeDaily({ projectSlug: 'p1', assignmentSlug: 'a1' }), // project member
      makeDaily({ projectSlug: 'p2', assignmentSlug: 'a1' }), // other project
      makeDaily({ projectSlug: '', assignmentSlug: 's1' }), // standalone member
      makeDaily({ projectSlug: '', assignmentSlug: 's2' }), // other standalone
      makeDaily({ projectSlug: '', assignmentSlug: '' }), // unattributed
    ]);
  }

  it('unions member projects + standalones and excludes unattributed/others', () => {
    initUsageDb(dbPath);
    seedDaily();
    const rows = listDaily({
      workspaceMembers: { projectSlugs: ['p1'], standaloneAssignmentIds: ['s1'] },
    });
    expect(rows.length).toBe(2);
    expect(rows.some((r) => r.project_slug === 'p1')).toBe(true);
    expect(rows.some((r) => r.project_slug === '' && r.assignment_slug === 's1')).toBe(true);
    // unattributed ('','') must NOT be included
    expect(rows.some((r) => r.project_slug === '' && r.assignment_slug === '')).toBe(false);
  });

  it('empty membership matches no rows (never all)', () => {
    initUsageDb(dbPath);
    seedDaily();
    expect(listDaily({ workspaceMembers: { projectSlugs: [], standaloneAssignmentIds: [] } }).length).toBe(0);
  });

  it('one-empty-side still filters correctly (e.g. _ungrouped with only standalones)', () => {
    initUsageDb(dbPath);
    seedDaily();
    const rows = listDaily({
      workspaceMembers: { projectSlugs: [], standaloneAssignmentIds: ['s1', 's2'] },
    });
    expect(rows.length).toBe(2);
    expect(rows.every((r) => r.project_slug === '')).toBe(true);
  });

  it('composes with model on the events table too', () => {
    initUsageDb(dbPath);
    upsertEvent(makeEvent({ sessionId: 'm1', model: 'opus', projectSlug: 'p1', assignmentSlug: 'a1' }));
    upsertEvent(makeEvent({ sessionId: 'm2', model: 'sonnet', projectSlug: 'p1', assignmentSlug: 'a1' }));
    upsertEvent(makeEvent({ sessionId: 'm3', model: 'opus', projectSlug: 'p2', assignmentSlug: 'a1' }));
    const rows = listEvents({
      model: 'opus',
      workspaceMembers: { projectSlugs: ['p1'], standaloneAssignmentIds: [] },
    });
    expect(rows.length).toBe(1);
    expect(rows[0].session_id).toBe('m1');
  });
});

describe('listDistinctModels / listDistinctTools', () => {
  it('returns sorted distinct values', () => {
    initUsageDb(dbPath);
    insertDailyBatch([
      makeDaily({ model: 'sonnet', tool: 'claude' }),
      makeDaily({ model: 'opus', tool: 'claude', day: '2026-05-20' }),
      makeDaily({ model: 'opus', tool: 'codex', day: '2026-05-19' }),
    ]);
    expect(listDistinctModels()).toEqual(['opus', 'sonnet']);
    expect(listDistinctTools()).toEqual(['claude', 'codex']);
  });
});
