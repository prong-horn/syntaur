import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import {
  initSessionDb,
  closeSessionDb,
  resetSessionDb,
  getSessionDb,
} from '../dashboard/session-db.js';
import {
  initEventsDb,
  closeEventsDb,
  resetEventsDb,
  getEventsDb,
} from '../db/events-db.js';
import {
  initUsageDb,
  closeUsageDb,
  resetUsageDb,
  getUsageDb,
} from '../db/usage-db.js';

const TICKET_UUID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

let testDir: string;
let dbPath: string;
let prevHome: string | undefined;

/** Pre-migration merged DB: old column names, UUID/slug values intact. */
function buildMergedUnmigratedDb(path: string): void {
  const db = new Database(path);
  db.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
    INSERT INTO meta (key, value) VALUES ('schema_version', '12');
    INSERT INTO meta (key, value) VALUES ('engagement_schema_version', '1');
    INSERT INTO meta (key, value) VALUES ('chat_schema_version', '4');
    INSERT INTO meta (key, value) VALUES ('events_schema_version', '1');
    INSERT INTO meta (key, value) VALUES ('usage_schema_version', '1');

    CREATE TABLE sessions (
      session_id TEXT PRIMARY KEY,
      agent TEXT NOT NULL,
      started TEXT NOT NULL,
      ended TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      path TEXT,
      description TEXT,
      transcript_path TEXT,
      original_head_sha TEXT,
      hosted_by TEXT,
      summary TEXT,
      summarized_at TEXT,
      description_source TEXT,
      pinned_at TEXT,
      archived_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE engagement (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      assignment_id TEXT,
      project_slug TEXT,
      assignment_slug TEXT,
      stage TEXT NOT NULL DEFAULT 'implement',
      started_at TEXT NOT NULL,
      ended_at TEXT,
      tokens_at_open TEXT,
      tokens_at_close TEXT,
      close_reason TEXT
    );

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

    CREATE TABLE chat_sessions (
      session_key TEXT PRIMARY KEY,
      assignment_id TEXT NOT NULL,
      project_slug TEXT,
      assignment_slug TEXT,
      agent_id TEXT NOT NULL,
      harness TEXT NOT NULL,
      acp_session_id TEXT,
      adapter_version TEXT,
      cwd TEXT,
      pid INTEGER,
      profile_json TEXT,
      usage_snapshot_json TEXT,
      state TEXT NOT NULL DEFAULT 'none',
      created_at TEXT NOT NULL,
      last_turn_at TEXT,
      last_delivered_seq INTEGER NOT NULL DEFAULT 0,
      commands_json TEXT,
      standing_fingerprint TEXT
    );

    CREATE TABLE chat_items (
      item_id TEXT PRIMARY KEY,
      assignment_id TEXT NOT NULL,
      session_key TEXT NOT NULL,
      turn_id TEXT,
      agent_id TEXT NOT NULL,
      type TEXT NOT NULL,
      ts TEXT NOT NULL,
      seq_first INTEGER NOT NULL,
      seq_last INTEGER NOT NULL,
      sealed INTEGER NOT NULL DEFAULT 0,
      json TEXT NOT NULL
    );

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
    `INSERT INTO engagement
       (session_id, assignment_id, project_slug, assignment_slug, stage, started_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run('sess-1', TICKET_UUID, 'proj-a', 'legacy-slug', 'implement', '2026-08-01T10:00:00.000Z');

  db.prepare(
    `INSERT INTO events (event_id, assignment_id, project_slug, at, actor, type)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run('evt-1', TICKET_UUID, 'proj-a', '2026-08-01T11:00:00.000Z', 'human', 'logged');

  db.prepare(
    `INSERT INTO chat_sessions (session_key, assignment_id, project_slug, assignment_slug, agent_id, harness, state, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(`${TICKET_UUID}:claude`, TICKET_UUID, 'proj-a', 'legacy-slug', 'agent-1', 'claude', 'idle', '2026-08-01T10:00:00.000Z');

  db.prepare(
    `INSERT INTO chat_items (item_id, assignment_id, session_key, agent_id, type, ts, seq_first, seq_last, sealed, json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run('item-1', TICKET_UUID, `${TICKET_UUID}:claude`, 'agent-1', 'user.message', '2026-08-01T10:01:00.000Z', 1, 1, 0, '{}');

  db.prepare(
    `INSERT INTO usage_events
       (session_id, model, tool, event_ts, project_slug, assignment_slug, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run('sess-1', 'claude-opus', 'claude', '2026-08-01T12:00:00.000Z', 'proj-a', 'legacy-slug', '2026-08-01T12:00:00.000Z');

  db.close();
}

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'syntaur-merged-open-'));
  dbPath = resolve(testDir, 'syntaur.db');
  prevHome = process.env.SYNTAUR_HOME;
  process.env.SYNTAUR_HOME = resolve(testDir, 'home');
  resetSessionDb();
  resetEventsDb();
  resetUsageDb();
});

afterEach(async () => {
  closeSessionDb();
  closeEventsDb();
  closeUsageDb();
  if (prevHome === undefined) delete process.env.SYNTAUR_HOME;
  else process.env.SYNTAUR_HOME = prevHome;
  await rm(testDir, { recursive: true, force: true });
});

describe('merged-but-unmigrated database opens and migrates in place', () => {
  it('opens without throw; UUID/slug values survive column renames until filesystem migrate v2', () => {
    buildMergedUnmigratedDb(dbPath);

    expect(() => initSessionDb(dbPath)).not.toThrow();
    expect(() => initEventsDb(dbPath)).not.toThrow();
    expect(() => initUsageDb(dbPath)).not.toThrow();

    const engagement = getSessionDb()
      .prepare('SELECT ticket_id FROM engagement WHERE session_id = ?')
      .get('sess-1') as { ticket_id: string };
    expect(engagement.ticket_id).toBe(TICKET_UUID);

    const event = getEventsDb()
      .prepare('SELECT ticket_id FROM events WHERE event_id = ?')
      .get('evt-1') as { ticket_id: string };
    expect(event.ticket_id).toBe(TICKET_UUID);

    const chatSession = getSessionDb()
      .prepare('SELECT ticket_id FROM chat_sessions WHERE session_key = ?')
      .get(`${TICKET_UUID}:claude`) as { ticket_id: string };
    expect(chatSession.ticket_id).toBe(TICKET_UUID);

    const usage = getUsageDb()
      .prepare('SELECT ticket_id, project_slug FROM usage_events WHERE session_id = ?')
      .get('sess-1') as { ticket_id: string; project_slug: string };
    expect(usage.ticket_id).toBe('legacy-slug');
    expect(usage.project_slug).toBe('proj-a');
  });
});
