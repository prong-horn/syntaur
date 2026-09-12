import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import {
  initEventsDb,
  closeEventsDb,
  resetEventsDb,
  getEventsDb,
} from '../db/events-db.js';

const HEAD_EVENTS_COLUMNS = [
  'event_id',
  'ticket_id',
  'at',
  'actor',
  'type',
  'details',
  'source_key',
];

let testDir: string;
let dbPath: string;

function eventsSchemaVersion(): string {
  return (
    getEventsDb()
      .prepare("SELECT value FROM meta WHERE key='events_schema_version'")
      .get() as { value: string }
  ).value;
}

function columns(): string[] {
  return (
    getEventsDb().prepare('PRAGMA table_info(events)').all() as Array<{ name: string }>
  ).map((c) => c.name);
}

function buildV1EventsDb(path: string): void {
  const db = new Database(path);
  db.exec(`
    CREATE TABLE events (
      event_id TEXT PRIMARY KEY,
      assignment_id TEXT NOT NULL,
      project_slug TEXT,
      at TEXT NOT NULL,
      actor TEXT NOT NULL,
      type TEXT NOT NULL,
      details TEXT,
      source_key TEXT UNIQUE
    );
    CREATE INDEX idx_events_ticket_at ON events(assignment_id, at);
    CREATE INDEX idx_events_at ON events(at);
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
    INSERT INTO meta (key, value) VALUES ('events_schema_version', '1');
  `);
  db.prepare(
    `INSERT INTO events (event_id, assignment_id, project_slug, at, actor, type, details, source_key)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    'evt-1',
    '11111111-1111-4111-8111-111111111111',
    'proj-a',
    '2026-07-01T10:00:00.000Z',
    'human',
    'status-change',
    '{"from":"pending"}',
    'backfill:one',
  );
  db.close();
}

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'syntaur-events-v2-mig-'));
  dbPath = resolve(testDir, 'syntaur.db');
  resetEventsDb();
});

afterEach(async () => {
  closeEventsDb();
  resetEventsDb();
  await rm(testDir, { recursive: true, force: true });
});

describe('events v1 → v2 migration (assignment_id → ticket_id, drop project_slug)', () => {
  it('preserves row values and column order, bumps events_schema_version to 2', () => {
    buildV1EventsDb(dbPath);
    initEventsDb(dbPath);

    expect(columns()).toEqual(HEAD_EVENTS_COLUMNS);
    expect(eventsSchemaVersion()).toBe('2');

    const row = getEventsDb()
      .prepare('SELECT * FROM events WHERE event_id = ?')
      .get('evt-1') as Record<string, unknown>;
    expect(row.ticket_id).toBe('11111111-1111-4111-8111-111111111111');
    expect(row.project_slug).toBeUndefined();
    expect(row.at).toBe('2026-07-01T10:00:00.000Z');
    expect(row.actor).toBe('human');
    expect(row.type).toBe('status-change');
    expect(row.details).toBe('{"from":"pending"}');
    expect(row.source_key).toBe('backfill:one');
  });

  it('fresh install lands on v2 directly', () => {
    initEventsDb(dbPath);
    expect(columns()).toEqual(HEAD_EVENTS_COLUMNS);
    expect(eventsSchemaVersion()).toBe('2');
  });
});
