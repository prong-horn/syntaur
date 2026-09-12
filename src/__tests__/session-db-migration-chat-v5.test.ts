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

const HEAD_CHAT_SESSIONS_COLUMNS = [
  'session_key',
  'ticket_id',
  'agent_id',
  'harness',
  'acp_session_id',
  'adapter_version',
  'cwd',
  'pid',
  'profile_json',
  'usage_snapshot_json',
  'state',
  'created_at',
  'last_turn_at',
  'last_delivered_seq',
  'commands_json',
  'standing_fingerprint',
];

const HEAD_CHAT_ITEMS_COLUMNS = [
  'item_id',
  'ticket_id',
  'session_key',
  'turn_id',
  'agent_id',
  'type',
  'ts',
  'seq_first',
  'seq_last',
  'sealed',
  'json',
];

const TICKET_UUID = '11111111-1111-4111-8111-111111111111';

let testDir: string;
let dbPath: string;
let prevHome: string | undefined;

function chatSchemaVersion(): string {
  return (
    getSessionDb()
      .prepare("SELECT value FROM meta WHERE key='chat_schema_version'")
      .get() as { value: string }
  ).value;
}

function buildV4ChatDb(path: string): void {
  const db = new Database(path);
  db.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
    INSERT INTO meta (key, value) VALUES ('chat_schema_version', '4');
    INSERT INTO meta (key, value) VALUES ('schema_version', '12');
    INSERT INTO meta (key, value) VALUES ('engagement_schema_version', '2');

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
    CREATE TABLE chat_harness_options (
      harness TEXT PRIMARY KEY,
      adapter_version TEXT,
      captured_at TEXT,
      record_json TEXT,
      auth_state TEXT NOT NULL DEFAULT 'unknown',
      auth_detail TEXT,
      auth_at TEXT
    );
  `);
  db.prepare(
    `INSERT INTO chat_sessions
       (session_key, assignment_id, project_slug, assignment_slug, agent_id, harness, state, created_at, last_delivered_seq)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    `${TICKET_UUID}:claude`,
    TICKET_UUID,
    'proj-a',
    'asg-1',
    'agent-1',
    'claude',
    'idle',
    '2026-08-01T10:00:00.000Z',
    3,
  );
  db.prepare(
    `INSERT INTO chat_items
       (item_id, assignment_id, session_key, agent_id, type, ts, seq_first, seq_last, sealed, json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    'item-1',
    TICKET_UUID,
    `${TICKET_UUID}:claude`,
    'agent-1',
    'user.message',
    '2026-08-01T10:01:00.000Z',
    1,
    1,
    0,
    '{"itemId":"item-1"}',
  );
  db.close();
}

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'syntaur-chat-v5-mig-'));
  dbPath = resolve(testDir, 'syntaur.db');
  prevHome = process.env.SYNTAUR_HOME;
  process.env.SYNTAUR_HOME = resolve(testDir, 'home');
  resetSessionDb();
});

afterEach(async () => {
  closeSessionDb();
  if (prevHome === undefined) delete process.env.SYNTAUR_HOME;
  else process.env.SYNTAUR_HOME = prevHome;
  await rm(testDir, { recursive: true, force: true });
});

describe('chat v4 → v5 migration (assignment_id → ticket_id, drop slugs)', () => {
  it('preserves every payload column, bumps chat_schema_version to 5', () => {
    buildV4ChatDb(dbPath);
    initSessionDb(dbPath);

    const sessionCols = (
      getSessionDb().prepare('PRAGMA table_info(chat_sessions)').all() as Array<{ name: string }>
    ).map((c) => c.name);
    const itemCols = (
      getSessionDb().prepare('PRAGMA table_info(chat_items)').all() as Array<{ name: string }>
    ).map((c) => c.name);

    expect(sessionCols).toEqual(HEAD_CHAT_SESSIONS_COLUMNS);
    expect(itemCols).toEqual(HEAD_CHAT_ITEMS_COLUMNS);
    expect(chatSchemaVersion()).toBe('5');

    const session = getSessionDb()
      .prepare('SELECT * FROM chat_sessions WHERE session_key = ?')
      .get(`${TICKET_UUID}:claude`) as Record<string, unknown>;
    expect(session.ticket_id).toBe(TICKET_UUID);
    expect(session.agent_id).toBe('agent-1');
    expect(session.harness).toBe('claude');
    expect(session.state).toBe('idle');
    expect(session.last_delivered_seq).toBe(3);

    const item = getSessionDb()
      .prepare('SELECT * FROM chat_items WHERE item_id = ?')
      .get('item-1') as Record<string, unknown>;
    expect(item.ticket_id).toBe(TICKET_UUID);
    expect(item.seq_first).toBe(1);
    expect(item.json).toBe('{"itemId":"item-1"}');
  });
});
