import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import {
  initEventsDb,
  getEventsDb,
  closeEventsDb,
  resetEventsDb,
  recordEvent,
  listEventsByTicket,
  hasEventsForTicket,
} from '../db/events-db.js';

let testDir: string;
let dbPath: string;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'syntaur-events-db-test-'));
  dbPath = resolve(testDir, 'syntaur.db');
  resetEventsDb();
});

afterEach(async () => {
  closeEventsDb();
  resetEventsDb();
  await rm(testDir, { recursive: true, force: true });
});

describe('initEventsDb', () => {
  it('creates the events + meta tables and seeds events_schema_version', () => {
    const db = initEventsDb(dbPath);
    const schema = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as Array<{ name: string }>;
    const names = schema.map((s) => s.name);
    expect(names).toContain('events');
    expect(names).toContain('meta');

    const version = db
      .prepare("SELECT value FROM meta WHERE key = 'events_schema_version'")
      .get() as { value: string } | undefined;
    expect(version?.value).toBe('2');
  });

  it('creates the expected indexes', () => {
    const db = initEventsDb(dbPath);
    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index'")
      .all() as Array<{ name: string }>;
    const names = indexes.map((i) => i.name);
    expect(names).toContain('idx_events_ticket_at');
    expect(names).toContain('idx_events_at');
  });

  it('declares source_key with a UNIQUE constraint', () => {
    const db = initEventsDb(dbPath);
    // sqlite implements column UNIQUE via an auto-index over source_key.
    const indexList = db.prepare('PRAGMA index_list(events)').all() as Array<{
      unique: number;
      name: string;
    }>;
    const uniqueIndexes = indexList.filter((i) => i.unique === 1);
    const coversSourceKey = uniqueIndexes.some((idx) => {
      const cols = db.prepare(`PRAGMA index_info(${JSON.stringify(idx.name)})`).all() as Array<{
        name: string;
      }>;
      return cols.length === 1 && cols[0].name === 'source_key';
    });
    expect(coversSourceKey).toBe(true);
  });

  it('returns the same singleton on repeat calls', () => {
    const a = initEventsDb(dbPath);
    const b = initEventsDb(dbPath);
    expect(a).toBe(b);
  });

  it('uses WAL journal mode', () => {
    const db = initEventsDb(dbPath);
    const mode = db.pragma('journal_mode', { simple: true });
    expect(mode).toBe('wal');
  });

  it('sets busy_timeout before WAL switch via openWalDatabase', () => {
    const db = initEventsDb(dbPath);
    const timeout = db.pragma('busy_timeout', { simple: true });
    expect(timeout).toBe(5000);
  });
});

describe('getEventsDb', () => {
  it('throws before init', () => {
    expect(() => getEventsDb()).toThrow(/not initialized/);
  });

  it('returns the handle after init', () => {
    initEventsDb(dbPath);
    expect(getEventsDb()).toBeDefined();
  });
});

describe('recordEvent + listEventsByTicket', () => {
  beforeEach(() => {
    initEventsDb(dbPath);
  });

  it('round-trips a live event (null source_key, defaulted at)', () => {
    recordEvent({
      ticketId: 'asn-1',
      projectSlug: 'proj',
      type: 'status-change',
      details: { from: 'pending', to: 'in_progress' },
      actor: 'agent:abcd1234',
    });

    const rows = listEventsByTicket('asn-1');
    expect(rows).toHaveLength(1);
    expect(rows[0].ticket_id).toBe('asn-1');
    expect(rows[0].type).toBe('status-change');
    expect(rows[0].actor).toBe('agent:abcd1234');
    expect(rows[0].source_key).toBeNull();
    expect(rows[0].at).toBeTruthy();
    expect(rows[0].event_id).toBeTruthy();
    expect(JSON.parse(rows[0].details as string)).toEqual({ from: 'pending', to: 'in_progress' });
  });

  it('round-trips a standalone event (null project_slug)', () => {
    recordEvent({ ticketId: 'asn-s', type: 'archived', actor: 'human' });
    const rows = listEventsByTicket('asn-s');
    expect(rows).toHaveLength(1);
    expect(rows[0].details).toBeNull();
  });

  it('passes a pre-stringified details string through unchanged', () => {
    recordEvent({
      ticketId: 'asn-str',
      type: 'fact-set',
      actor: 'human',
      details: '{"name":"x"}',
    });
    const rows = listEventsByTicket('asn-str');
    expect(rows[0].details).toBe('{"name":"x"}');
  });

  it('honors an explicit backfill at + actor', () => {
    recordEvent({
      ticketId: 'asn-bf',
      type: 'status-change',
      actor: 'system',
      at: '2020-01-01T00:00:00.000Z',
      sourceKey: 'backfill~asn-bf~status~0',
    });
    const rows = listEventsByTicket('asn-bf');
    expect(rows[0].at).toBe('2020-01-01T00:00:00.000Z');
    expect(rows[0].actor).toBe('system');
    expect(rows[0].source_key).toBe('backfill~asn-bf~status~0');
  });

  it('isolates events by ticket_id', () => {
    recordEvent({ ticketId: 'x', type: 'archived', actor: 'human' });
    recordEvent({ ticketId: 'y', type: 'archived', actor: 'human' });
    expect(listEventsByTicket('x')).toHaveLength(1);
    expect(listEventsByTicket('y')).toHaveLength(1);
  });
});

describe('source_key idempotency (INSERT OR IGNORE)', () => {
  beforeEach(() => initEventsDb(dbPath));

  it('two recordEvent calls with the same non-null source_key produce ONE row', () => {
    recordEvent({
      ticketId: 'asn-1',
      type: 'status-change',
      actor: 'system',
      at: '2020-01-01T00:00:00.000Z',
      sourceKey: 'backfill~asn-1~status~0',
    });
    recordEvent({
      ticketId: 'asn-1',
      type: 'status-change',
      actor: 'system',
      at: '2021-06-06T00:00:00.000Z',
      sourceKey: 'backfill~asn-1~status~0',
    });
    expect(listEventsByTicket('asn-1')).toHaveLength(1);
  });

  it('two recordEvent calls with source_key null produce TWO rows', () => {
    recordEvent({ ticketId: 'asn-2', type: 'comment-added', actor: 'human', sourceKey: null });
    recordEvent({ ticketId: 'asn-2', type: 'comment-added', actor: 'human', sourceKey: null });
    expect(listEventsByTicket('asn-2')).toHaveLength(2);
  });

  it('omitting source_key behaves like null (always inserts)', () => {
    recordEvent({ ticketId: 'asn-3', type: 'comment-added', actor: 'human' });
    recordEvent({ ticketId: 'asn-3', type: 'comment-added', actor: 'human' });
    expect(listEventsByTicket('asn-3')).toHaveLength(2);
  });
});

describe('listEventsByTicket filters + ordering', () => {
  beforeEach(() => {
    initEventsDb(dbPath);
    // Explicit, sortable timestamps so ordering/filtering is deterministic.
    recordEvent({ ticketId: 'x', type: 'status-change', actor: 'system', at: '2020-01-01T00:00:00.000Z' });
    recordEvent({ ticketId: 'x', type: 'comment-added', actor: 'human', at: '2021-01-01T00:00:00.000Z' });
    recordEvent({ ticketId: 'x', type: 'status-change', actor: 'system', at: '2022-01-01T00:00:00.000Z' });
  });

  it('orders newest-first (at DESC)', () => {
    const rows = listEventsByTicket('x');
    expect(rows.map((r) => r.at)).toEqual([
      '2022-01-01T00:00:00.000Z',
      '2021-01-01T00:00:00.000Z',
      '2020-01-01T00:00:00.000Z',
    ]);
  });

  it('applies since (at >= since)', () => {
    const rows = listEventsByTicket('x', { since: '2021-01-01T00:00:00.000Z' });
    expect(rows.map((r) => r.at)).toEqual([
      '2022-01-01T00:00:00.000Z',
      '2021-01-01T00:00:00.000Z',
    ]);
  });

  it('applies types (IN filter)', () => {
    const rows = listEventsByTicket('x', { types: ['comment-added'] });
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe('comment-added');
  });

  it('applies multiple types', () => {
    const rows = listEventsByTicket('x', { types: ['status-change', 'comment-added'] });
    expect(rows).toHaveLength(3);
  });

  it('applies limit (still newest-first)', () => {
    const rows = listEventsByTicket('x', { limit: 2 });
    expect(rows).toHaveLength(2);
    expect(rows[0].at).toBe('2022-01-01T00:00:00.000Z');
    expect(rows[1].at).toBe('2021-01-01T00:00:00.000Z');
  });

  it('combines since + types + limit', () => {
    const rows = listEventsByTicket('x', {
      since: '2020-06-01T00:00:00.000Z',
      types: ['status-change'],
      limit: 1,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].at).toBe('2022-01-01T00:00:00.000Z');
  });
});

describe('hasEventsForTicket', () => {
  beforeEach(() => initEventsDb(dbPath));

  it('returns false when no events exist', () => {
    expect(hasEventsForTicket('none')).toBe(false);
  });

  it('returns true once an event is recorded', () => {
    recordEvent({ ticketId: 'has', type: 'archived', actor: 'human' });
    expect(hasEventsForTicket('has')).toBe(true);
  });
});

describe('best-effort: recordEvent never throws', () => {
  it('does not throw when the db is closed (logs and returns)', () => {
    initEventsDb(dbPath);
    closeEventsDb();
    // db handle is closed AND the singleton was nulled by closeEventsDb(); a
    // lazy re-init will reopen the same file, so this insert actually succeeds
    // — but it must not throw regardless.
    expect(() =>
      recordEvent({ ticketId: 'asn-closed', type: 'archived', actor: 'human' }),
    ).not.toThrow();
  });

  it('does not throw against a broken db handle (closed handle, singleton kept)', () => {
    const db = initEventsDb(dbPath);
    // Close the underlying handle WITHOUT resetting the module singleton, so
    // recordEvent reuses the now-broken handle and the prepared INSERT throws
    // internally — recordEvent must catch, warn, and return.
    db.close();
    expect(() =>
      recordEvent({ ticketId: 'asn-broken', type: 'archived', actor: 'human' }),
    ).not.toThrow();
    // Reset so afterEach's closeEventsDb() doesn't double-close the handle.
    resetEventsDb();
  });
});
