import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import {
  initUsageDb,
  closeUsageDb,
  resetUsageDb,
  getUsageDb,
} from '../db/usage-db.js';

const HEAD_USAGE_EVENTS_COLUMNS = [
  'session_id',
  'model',
  'tool',
  'event_ts',
  'input_tokens',
  'output_tokens',
  'cache_creation_tokens',
  'cache_read_tokens',
  'total_tokens',
  'total_cost',
  'cwd',
  'project_slug',
  'ticket_id',
  'raw_json',
  'updated_at',
];

const HEAD_USAGE_DAILY_COLUMNS = [
  'day',
  'tool',
  'model',
  'project_slug',
  'ticket_id',
  'input_tokens',
  'output_tokens',
  'cache_creation_tokens',
  'cache_read_tokens',
  'total_tokens',
  'total_cost',
  'frozen',
  'computed_at',
];

let testDir: string;
let dbPath: string;

function usageSchemaVersion(): string {
  return (
    getUsageDb()
      .prepare("SELECT value FROM meta WHERE key='usage_schema_version'")
      .get() as { value: string }
  ).value;
}

function buildV1UsageDb(path: string): void {
  const db = new Database(path);
  db.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
    INSERT INTO meta (key, value) VALUES ('usage_schema_version', '1');

    CREATE TABLE usage_events (
      session_id TEXT NOT NULL,
      model TEXT NOT NULL,
      tool TEXT NOT NULL,
      event_ts TEXT NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      total_cost REAL NOT NULL DEFAULT 0,
      cwd TEXT,
      project_slug TEXT NOT NULL DEFAULT '',
      assignment_slug TEXT NOT NULL DEFAULT '',
      raw_json TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (session_id, model)
    );

    CREATE TABLE usage_daily (
      day TEXT NOT NULL,
      tool TEXT NOT NULL,
      model TEXT NOT NULL,
      project_slug TEXT NOT NULL DEFAULT '',
      assignment_slug TEXT NOT NULL DEFAULT '',
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      total_cost REAL NOT NULL DEFAULT 0,
      frozen INTEGER NOT NULL DEFAULT 0,
      computed_at TEXT NOT NULL,
      PRIMARY KEY (day, tool, model, project_slug, assignment_slug)
    );
  `);
  db.prepare(
    `INSERT INTO usage_events
       (session_id, model, tool, event_ts, input_tokens, output_tokens, total_tokens, total_cost,
        project_slug, assignment_slug, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    'sess-1',
    'claude-opus',
    'claude',
    '2026-05-21T12:00:00.000Z',
    100,
    200,
    300,
    0.5,
    'proj-a',
    'asg-1',
    '2026-05-21T12:01:00.000Z',
  );
  db.prepare(
    `INSERT INTO usage_daily
       (day, tool, model, project_slug, assignment_slug, input_tokens, output_tokens,
        total_tokens, total_cost, frozen, computed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    '2026-05-21',
    'claude',
    'claude-opus',
    'proj-a',
    'asg-1',
    100,
    200,
    300,
    0.5,
    0,
    '2026-05-21T12:02:00.000Z',
  );
  db.close();
}

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'syntaur-usage-v3-mig-'));
  dbPath = resolve(testDir, 'syntaur.db');
  resetUsageDb();
});

afterEach(async () => {
  closeUsageDb();
  resetUsageDb();
  await rm(testDir, { recursive: true, force: true });
});

describe('usage v1 → v3 migration (assignment_slug → ticket_id)', () => {
  it('preserves slug values in ticket_id and bumps usage_schema_version to 3', () => {
    buildV1UsageDb(dbPath);
    initUsageDb(dbPath);

    const eventCols = (
      getUsageDb().prepare('PRAGMA table_info(usage_events)').all() as Array<{ name: string }>
    ).map((c) => c.name);
    const dailyCols = (
      getUsageDb().prepare('PRAGMA table_info(usage_daily)').all() as Array<{ name: string }>
    ).map((c) => c.name);

    expect(eventCols).toEqual(HEAD_USAGE_EVENTS_COLUMNS);
    expect(dailyCols).toEqual(HEAD_USAGE_DAILY_COLUMNS);
    expect(usageSchemaVersion()).toBe('3');

    const event = getUsageDb()
      .prepare('SELECT * FROM usage_events WHERE session_id = ?')
      .get('sess-1') as Record<string, unknown>;
    expect(event.project_slug).toBe('proj-a');
    expect(event.ticket_id).toBe('asg-1');
    expect(event.total_tokens).toBe(300);

    const daily = getUsageDb()
      .prepare('SELECT * FROM usage_daily WHERE day = ?')
      .get('2026-05-21') as Record<string, unknown>;
    expect(daily.project_slug).toBe('proj-a');
    expect(daily.ticket_id).toBe('asg-1');
  });

  it('fresh install lands on v3 directly', () => {
    initUsageDb(dbPath);
    expect(usageSchemaVersion()).toBe('3');
  });
});
