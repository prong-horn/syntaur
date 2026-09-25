import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { rekeyTicket } from '../db/ticket-rekey.js';

let testDir: string;
let dbPath: string;

function snapshotDb(path: string, omitTables: string[] = []): string {
  const db = new Database(path, { readonly: true });
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all() as Array<{ name: string }>;
  const out: Record<string, unknown[]> = {};
  for (const { name } of tables) {
    if (omitTables.includes(name)) continue;
    out[name] = db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all();
  }
  db.close();
  return JSON.stringify(out);
}

function seedDb(db: Database.Database): void {
  db.exec(`
    CREATE TABLE events (
      event_id TEXT PRIMARY KEY,
      ticket_id TEXT NOT NULL,
      at TEXT NOT NULL,
      actor TEXT NOT NULL,
      type TEXT NOT NULL,
      details TEXT,
      source_key TEXT UNIQUE
    );
    CREATE TABLE engagement (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      ticket_id TEXT,
      stage TEXT NOT NULL DEFAULT 'implement',
      started_at TEXT NOT NULL
    );
    CREATE TABLE chat_sessions (
      session_key TEXT PRIMARY KEY,
      ticket_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      harness TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'none',
      created_at TEXT NOT NULL
    );
    CREATE TABLE chat_items (
      item_id TEXT PRIMARY KEY,
      ticket_id TEXT NOT NULL,
      session_key TEXT NOT NULL,
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
      total_tokens INTEGER NOT NULL DEFAULT 0,
      total_cost REAL NOT NULL DEFAULT 0,
      project_slug TEXT NOT NULL DEFAULT '',
      ticket_id TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL,
      PRIMARY KEY (session_id, model)
    );
    CREATE TABLE usage_daily (
      day TEXT NOT NULL,
      tool TEXT NOT NULL,
      model TEXT NOT NULL,
      project_slug TEXT NOT NULL DEFAULT '',
      ticket_id TEXT NOT NULL DEFAULT '',
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      total_cost REAL NOT NULL DEFAULT 0,
      frozen INTEGER NOT NULL DEFAULT 0,
      computed_at TEXT NOT NULL,
      PRIMARY KEY (day, tool, model, project_slug, ticket_id)
    );
  `);

  db.prepare(
    `INSERT INTO events (event_id, ticket_id, at, actor, type, source_key) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run('e1', 'OLD-1', 't', 'a', 'log', 'log~OLD-1~x');
  db.prepare(
    `INSERT INTO events (event_id, ticket_id, at, actor, type, source_key) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run('e2', 'OLD-1', 't', 'a', 'migrate', 'migrate~OLD-1~archived');

  db.prepare(
    `INSERT INTO engagement (session_id, ticket_id, stage, started_at) VALUES (?, ?, ?, ?)`,
  ).run('s1', 'OLD-1', 'implement', 't');

  db.prepare(
    `INSERT INTO chat_sessions (session_key, ticket_id, agent_id, harness, state, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run('OLD-1~claude', 'OLD-1', 'claude', 'claude-code', 'stopped', 't');

  db.prepare(
    `INSERT INTO chat_items (item_id, ticket_id, session_key, agent_id, type, ts, seq_first, seq_last, json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run('session~OLD-1~t1', 'OLD-1', 'OLD-1~claude', 'claude', 'note', 't', 1, 1, '{"ticketId":"OLD-1"}');

  db.prepare(
    `INSERT INTO usage_events (session_id, model, tool, event_ts, project_slug, ticket_id, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run('u1', 'm', 'claude', 't', 'src-proj', 'OLD-1', 't');
  db.prepare(
    `INSERT INTO usage_events (session_id, model, tool, event_ts, project_slug, ticket_id, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run('u-proj', 'm', 'claude', 't', 'src-proj', '', 't');

  db.prepare(
    `INSERT INTO usage_daily (day, tool, model, project_slug, ticket_id, input_tokens, computed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run('2026-01-01', 'claude', 'm', 'src-proj', 'OLD-1', 10, 't');
  db.prepare(
    `INSERT INTO usage_daily (day, tool, model, project_slug, ticket_id, input_tokens, computed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run('2026-01-01', 'claude', 'm', 'src-proj', 'NEW-1', 5, 't');
  db.prepare(
    `INSERT INTO usage_daily (day, tool, model, project_slug, ticket_id, input_tokens, computed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run('2026-01-01', 'claude', 'm', 'src-proj', '', 99, 't');
}

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'syntaur-ticket-rekey-'));
  dbPath = resolve(testDir, 'syntaur.db');
  const db = new Database(dbPath);
  seedDb(db);
  db.close();
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

describe('rekeyTicket', () => {
  it('re-keys every table and merges usage_daily collisions', () => {
    rekeyTicket(dbPath, {
      oldId: 'OLD-1',
      newId: 'NEW-1',
      oldProjectSlug: 'src-proj',
      newProjectSlug: 'dst-proj',
    });

    const db = new Database(dbPath, { readonly: true });
    expect(
      (db.prepare('SELECT ticket_id FROM events WHERE event_id = ?').get('e1') as { ticket_id: string })
        .ticket_id,
    ).toBe('NEW-1');
    expect(
      (db.prepare('SELECT source_key FROM events WHERE event_id = ?').get('e1') as { source_key: string })
        .source_key,
    ).toBe('log~NEW-1~x');
    expect(
      (db.prepare('SELECT source_key FROM events WHERE event_id = ?').get('e2') as { source_key: string })
        .source_key,
    ).toBe('migrate~NEW-1~archived');

    expect(
      (db.prepare('SELECT ticket_id FROM engagement WHERE session_id = ?').get('s1') as { ticket_id: string })
        .ticket_id,
    ).toBe('NEW-1');

    const chat = db
      .prepare('SELECT ticket_id, session_key FROM chat_sessions WHERE session_key = ?')
      .get('NEW-1~claude') as { ticket_id: string; session_key: string };
    expect(chat.ticket_id).toBe('NEW-1');

    expect(
      (db.prepare('SELECT COUNT(*) AS n FROM chat_items WHERE ticket_id = ?').get('OLD-1') as { n: number }).n,
    ).toBe(0);

    const usage = db
      .prepare('SELECT ticket_id, project_slug FROM usage_events WHERE session_id = ?')
      .get('u1') as { ticket_id: string; project_slug: string };
    expect(usage).toEqual({ ticket_id: 'NEW-1', project_slug: 'dst-proj' });

    const projUsage = db
      .prepare('SELECT ticket_id, input_tokens FROM usage_events WHERE session_id = ?')
      .get('u-proj') as { ticket_id: string; input_tokens: number };
    expect(projUsage).toEqual({ ticket_id: '', input_tokens: 0 });

    const daily = db
      .prepare(
        'SELECT ticket_id, project_slug, input_tokens FROM usage_daily WHERE day = ? AND tool = ? AND model = ? AND project_slug = ? AND ticket_id = ?',
      )
      .get('2026-01-01', 'claude', 'm', 'dst-proj', 'NEW-1') as {
      ticket_id: string;
      project_slug: string;
      input_tokens: number;
    };
    expect(daily.input_tokens).toBe(15);
    expect(
      (db.prepare('SELECT COUNT(*) AS n FROM usage_daily WHERE ticket_id = ?').get('OLD-1') as { n: number }).n,
    ).toBe(0);

    const projDaily = db
      .prepare(
        'SELECT input_tokens FROM usage_daily WHERE day = ? AND project_slug = ? AND ticket_id = ?',
      )
      .get('2026-01-01', 'src-proj', '') as { input_tokens: number };
    expect(projDaily.input_tokens).toBe(99);

    db.close();
  });

  it('inverse rekey restores the original rows when there is no usage_daily collision', () => {
    const simplePath = resolve(testDir, 'simple.db');
    const db = new Database(simplePath);
    seedDb(db);
    db.prepare('DELETE FROM usage_daily WHERE ticket_id = ?').run('NEW-1');
    db.close();

    const omit = ['chat_items'];
    const before = snapshotDb(simplePath, omit);
    rekeyTicket(simplePath, {
      oldId: 'OLD-1',
      newId: 'NEW-1',
      oldProjectSlug: 'src-proj',
      newProjectSlug: 'dst-proj',
    });
    rekeyTicket(simplePath, {
      oldId: 'NEW-1',
      newId: 'OLD-1',
      oldProjectSlug: 'dst-proj',
      newProjectSlug: 'src-proj',
    });
    expect(snapshotDb(simplePath, omit)).toBe(before);
  });
});
