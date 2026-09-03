import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { closeSessionDb, getSessionDb as getSessionDbForTest, initSessionDb } from '../dashboard/session-db.js';
import {
  applyChatPatch,
  countChatItems,
  deleteChatItem,
  deleteChatItems,
  getChatSession,
  getChatSessionByKey,
  listChatItemRows,
  listChatItems,
  listChatSessions,
  upsertChatItem,
  upsertChatSession,
} from '../db/chat-db.js';
import { CHAT_SCHEMA_VERSION } from '../db/chat-schema.js';
import { ChatNormalizer } from '../chat/normalizer.js';
import { chatLogPath, openChatLog, readEvents, rebuildChatIndex, replayItems } from '../chat/store.js';
import type { ChatEvent, ChatItem } from '../chat/types.js';
import { fixtureEvents, listFixtures } from './helpers/acp-fixtures.js';

/**
 * Task 5 — `chat/events.jsonl` (the source of truth) and the SQLite index built
 * from it. The invariant under test is Decision 2's: replaying the log through a
 * fresh normalizer reproduces the live index exactly.
 */

let sandbox: string;
let assignmentDir: string;

const ASSIGNMENT_ID = 'assignment-1';
const SESSION_KEY = 'assignment-1:claude';

function item(overrides: Partial<ChatItem> & Pick<ChatItem, 'itemId'>): ChatItem {
  return {
    assignmentId: ASSIGNMENT_ID,
    turnId: 't1',
    agentId: 'claude',
    type: 'system',
    ts: '2026-09-02T12:00:00.000Z',
    seqFirst: 0,
    seqLast: 0,
    sealed: true,
    level: 'info',
    text: 'hello',
    ...overrides,
  } as ChatItem;
}

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'syntaur-chat-store-'));
  assignmentDir = join(sandbox, 'assignment');
  await mkdir(assignmentDir, { recursive: true });
  closeSessionDb();
  initSessionDb(join(sandbox, 'syntaur.db'));
});

afterEach(async () => {
  closeSessionDb();
  await rm(sandbox, { recursive: true, force: true });
});

describe('event log', () => {
  it('creates chat/ on first use and assigns monotonic seqs', async () => {
    const log = await openChatLog(assignmentDir);
    expect(log.path).toBe(chatLogPath(assignmentDir));
    const a = await log.append({
      assignmentId: ASSIGNMENT_ID,
      agentId: 'claude',
      sessionKey: SESSION_KEY,
      turnId: null,
      kind: 'user.message',
      payload: { messageId: 'm1', text: 'hi' },
    });
    const b = await log.append({
      assignmentId: ASSIGNMENT_ID,
      agentId: 'claude',
      sessionKey: SESSION_KEY,
      turnId: 't1',
      kind: 'turn.start',
      payload: { messageId: 'm1' },
    });
    expect(a.seq).toBe(0);
    expect(b.seq).toBe(1);
    expect(await log.readAll()).toHaveLength(2);
    const raw = await readFile(log.path, 'utf-8');
    expect(raw.endsWith('\n')).toBe(true);
    expect(raw.trim().split('\n')).toHaveLength(2);
  });

  it('recovers seq across a reopen', async () => {
    const first = await openChatLog(assignmentDir);
    for (let i = 0; i < 3; i++) {
      await first.append({
        assignmentId: ASSIGNMENT_ID,
        agentId: 'claude',
        sessionKey: SESSION_KEY,
        turnId: null,
        kind: 'system',
        payload: { level: 'info', text: `n${i}` },
      });
    }
    const second = await openChatLog(assignmentDir);
    expect(second.nextSeq).toBe(3);
    const next = await second.append({
      assignmentId: ASSIGNMENT_ID,
      agentId: 'claude',
      sessionKey: SESSION_KEY,
      turnId: null,
      kind: 'system',
      payload: { level: 'info', text: 'n3' },
    });
    expect(next.seq).toBe(3);
    expect((await second.readAll()).map((e) => e.seq)).toEqual([0, 1, 2, 3]);
  });

  it('tolerates a torn final line and keeps appending after it', async () => {
    const log = await openChatLog(assignmentDir);
    await log.append({
      assignmentId: ASSIGNMENT_ID,
      agentId: 'claude',
      sessionKey: SESSION_KEY,
      turnId: null,
      kind: 'system',
      payload: { level: 'info', text: 'first' },
    });
    // Simulate a crash mid-append.
    await writeFile(log.path, (await readFile(log.path, 'utf-8')) + '{"seq":1,"ts":"2026', 'utf-8');

    const events = await readEvents(log.path);
    expect(events).toHaveLength(1);

    const reopened = await openChatLog(assignmentDir);
    expect(reopened.nextSeq).toBe(1);
    await reopened.append({
      assignmentId: ASSIGNMENT_ID,
      agentId: 'claude',
      sessionKey: SESSION_KEY,
      turnId: null,
      kind: 'system',
      payload: { level: 'info', text: 'second' },
    });
    const after = await readEvents(log.path);
    expect(after.map((e) => e.seq)).toEqual([0, 1]);
  });

  it('serialises concurrent appends without losing or duplicating a seq', async () => {
    const log = await openChatLog(assignmentDir);
    await Promise.all(
      Array.from({ length: 25 }, (_, i) =>
        log.append({
          assignmentId: ASSIGNMENT_ID,
          agentId: 'claude',
          sessionKey: SESSION_KEY,
          turnId: null,
          kind: 'system',
          payload: { level: 'info', text: `n${i}` },
        }),
      ),
    );
    const events = await log.readAll();
    expect(events.map((e) => e.seq)).toEqual(Array.from({ length: 25 }, (_, i) => i));
  });

  it('readAfter pages forward', async () => {
    const log = await openChatLog(assignmentDir);
    for (let i = 0; i < 5; i++) {
      await log.append({
        assignmentId: ASSIGNMENT_ID,
        agentId: 'claude',
        sessionKey: SESSION_KEY,
        turnId: null,
        kind: 'system',
        payload: { level: 'info', text: `n${i}` },
      });
    }
    expect((await log.readAfter(2)).map((e) => e.seq)).toEqual([3, 4]);
  });

  it('an empty or missing log reads as no events', async () => {
    expect(await readEvents(join(sandbox, 'nope.jsonl'))).toEqual([]);
    const log = await openChatLog(assignmentDir);
    expect(await log.readAll()).toEqual([]);
    expect(log.nextSeq).toBe(0);
  });
});

describe('chat_items index', () => {
  it('registers its own schema version alongside the others', () => {
    const db = initSessionDb();
    const rows = db.prepare('SELECT key, value FROM meta').all() as Array<{ key: string; value: string }>;
    const chat = rows.find((r) => r.key === 'chat_schema_version');
    expect(chat?.value).toBe(CHAT_SCHEMA_VERSION);
    // Three independent keys — the sessions table's own version is not this one.
    expect(rows.find((r) => r.key === 'schema_version')?.value).not.toBe(undefined);
    expect(rows.find((r) => r.key === 'engagement_schema_version')?.value).toBe('1');
  });

  it('upsert is idempotent by item_id', () => {
    upsertChatItem(SESSION_KEY, item({ itemId: 't1:0', text: 'v1' }));
    upsertChatItem(SESSION_KEY, item({ itemId: 't1:0', text: 'v2', seqLast: 5 }));
    const items = listChatItems(ASSIGNMENT_ID);
    expect(items).toHaveLength(1);
    expect((items[0] as { text: string }).text).toBe('v2');
    expect(items[0].seqLast).toBe(5);
  });

  it('a retract patch deletes the row', () => {
    applyChatPatch(SESSION_KEY, { op: 'upsert', item: item({ itemId: 't1:0' }) });
    expect(countChatItems(ASSIGNMENT_ID)).toBe(1);
    applyChatPatch(SESSION_KEY, { op: 'retract', itemId: 't1:0' });
    expect(countChatItems(ASSIGNMENT_ID)).toBe(0);
    // Retracting an unknown id is a no-op, not an error.
    deleteChatItem('nope');
  });

  it('pages newest-first and returns each page oldest-first', () => {
    for (let i = 0; i < 10; i++) {
      upsertChatItem(SESSION_KEY, item({ itemId: `t1:${i}`, seqFirst: i, seqLast: i }));
    }
    const newest = listChatItems(ASSIGNMENT_ID, { limit: 3 });
    expect(newest.map((i) => i.seqFirst)).toEqual([7, 8, 9]);
    const older = listChatItems(ASSIGNMENT_ID, { limit: 3, beforeSeq: newest[0].seqFirst });
    expect(older.map((i) => i.seqFirst)).toEqual([4, 5, 6]);
  });

  it('keeps assignments apart', () => {
    upsertChatItem(SESSION_KEY, item({ itemId: 't1:0' }));
    upsertChatItem('other:claude', item({ itemId: 't2:0', assignmentId: 'assignment-2' }));
    expect(countChatItems(ASSIGNMENT_ID)).toBe(1);
    expect(deleteChatItems('assignment-2')).toBe(1);
    expect(countChatItems(ASSIGNMENT_ID)).toBe(1);
  });
});

describe('chat_sessions', () => {
  const base = {
    sessionKey: SESSION_KEY,
    assignmentId: ASSIGNMENT_ID,
    projectSlug: 'syntaur-meta',
    assignmentSlug: 'chat',
    agentId: 'claude',
    harness: 'claude',
    state: 'spawning',
  };

  it('upserts and reads back by (assignment, agent) and by key', () => {
    upsertChatSession({ ...base, acpSessionId: 'acp-1', pid: 4242 });
    const row = getChatSession(ASSIGNMENT_ID, 'claude');
    expect(row?.acp_session_id).toBe('acp-1');
    expect(row?.pid).toBe(4242);
    expect(row?.state).toBe('spawning');
    expect(getChatSessionByKey(SESSION_KEY)?.session_key).toBe(SESSION_KEY);
    expect(getChatSession(ASSIGNMENT_ID, 'codex')).toBeNull();
    expect(listChatSessions(ASSIGNMENT_ID)).toHaveLength(1);
  });

  it('a state transition never erases the ACP session id resume needs', () => {
    upsertChatSession({ ...base, acpSessionId: 'acp-1', adapterVersion: 'x@1', cwd: '/tmp/w' });
    upsertChatSession({ ...base, state: 'idle' });
    const row = getChatSession(ASSIGNMENT_ID, 'claude');
    expect(row?.state).toBe('idle');
    expect(row?.acp_session_id).toBe('acp-1');
    expect(row?.adapter_version).toBe('x@1');
    expect(row?.cwd).toBe('/tmp/w');
  });
});

describe('rebuild == live', () => {
  async function seedFromFixture(name: string): Promise<{ events: ChatEvent[]; live: ChatItem[] }> {
    const fixture = listFixtures().find((f) => f.name === name)!;
    const raw = fixtureEvents(fixture.path, { assignmentId: ASSIGNMENT_ID, agentId: 'claude' });
    const log = await openChatLog(assignmentDir);
    const events: ChatEvent[] = [];
    // Write the log the way the broker does — one append per event — and index
    // each patch as it is produced, exactly like the live path.
    const normalizer = new ChatNormalizer({
      assignmentId: ASSIGNMENT_ID,
      agentId: 'claude',
      sessionKey: SESSION_KEY,
    });
    for (const e of raw) {
      const stored = await log.append({
        assignmentId: ASSIGNMENT_ID,
        agentId: 'claude',
        sessionKey: SESSION_KEY,
        turnId: e.turnId,
        kind: e.kind,
        payload: e.payload,
        ts: e.ts,
      });
      events.push(stored);
      for (const patch of normalizer.ingest(stored)) applyChatPatch(SESSION_KEY, patch);
    }
    return { events, live: listChatItems(ASSIGNMENT_ID, { limit: 1000 }) };
  }

  it('a rebuilt index equals the live index, row for row', async () => {
    const { live } = await seedFromFixture('claude/07-permissions.ndjson');
    const liveRows = listChatItemRows(ASSIGNMENT_ID);
    expect(live.length).toBeGreaterThan(5);

    const result = await rebuildChatIndex(assignmentDir, ASSIGNMENT_ID);
    expect(result.deleted).toBe(liveRows.length);
    expect(result.items).toBe(liveRows.length);
    expect(listChatItemRows(ASSIGNMENT_ID)).toEqual(liveRows);
  });

  it('holds for a transcript with tool cards, a fold and a plan', async () => {
    await seedFromFixture('claude/08-plan-events.ndjson');
    const liveRows = listChatItemRows(ASSIGNMENT_ID);
    await rebuildChatIndex(assignmentDir, ASSIGNMENT_ID);
    expect(listChatItemRows(ASSIGNMENT_ID)).toEqual(liveRows);
  });

  it('a rebuild removes rows the fold retracted rather than resurrecting them', async () => {
    await seedFromFixture('claude/05-tool-calls.ndjson');
    const liveRows = listChatItemRows(ASSIGNMENT_ID);
    // The narration bubble folded into the card, so it is not in the index.
    expect(liveRows.some((r) => r.type === 'agent.work')).toBe(true);
    const card = JSON.parse(liveRows.find((r) => r.type === 'agent.work')!.json) as {
      lead?: string;
    };
    expect(card.lead).toBeDefined();

    await rebuildChatIndex(assignmentDir, ASSIGNMENT_ID);
    expect(listChatItemRows(ASSIGNMENT_ID)).toEqual(liveRows);
  });

  it('replayItems matches what the index holds', async () => {
    const { events, live } = await seedFromFixture('codex/05-tool-calls.ndjson');
    expect(replayItems(events, ASSIGNMENT_ID)).toEqual(live);
  });

  it('rebuilding an assignment with no log clears its index', async () => {
    upsertChatItem(SESSION_KEY, item({ itemId: 'stale:0' }));
    const result = await rebuildChatIndex(assignmentDir, ASSIGNMENT_ID);
    expect(result).toEqual({ events: 0, items: 0, deleted: 1 });
  });
});

describe('rebuild == live across the assignment scope (Task 5)', () => {
  const ASSIGNMENT_SCOPE = `${ASSIGNMENT_ID}:@assignment`;
  const PLANNER_KEY = `${ASSIGNMENT_ID}:planner`;
  const IMPLEMENTER_KEY = `${ASSIGNMENT_ID}:implementer`;

  /**
   * A two-agent chat as the broker writes it: the routing rows in the
   * assignment scope, each agent's turn under its own key, and all of it
   * interleaved in one `events.jsonl` (Decision 3). `rebuildChatIndex` builds
   * one normalizer per distinct `sessionKey`, so this is the case that proves
   * the new key needs nothing else.
   */
  async function seedTwoAgents(): Promise<void> {
    const log = await openChatLog(assignmentDir);
    const normalizers = new Map<string, ChatNormalizer>();
    const write = async (
      sessionKey: string,
      agentId: string,
      turnId: string | null,
      kind: ChatEvent['kind'],
      payload: unknown,
    ) => {
      const stored = await log.append({
        assignmentId: ASSIGNMENT_ID,
        agentId,
        sessionKey,
        turnId,
        kind,
        payload,
      });
      let normalizer = normalizers.get(sessionKey);
      if (!normalizer) {
        normalizer = new ChatNormalizer({ assignmentId: ASSIGNMENT_ID, agentId, sessionKey });
        normalizers.set(sessionKey, normalizer);
      }
      for (const patch of normalizer.ingest(stored)) applyChatPatch(sessionKey, patch);
    };

    await write(ASSIGNMENT_SCOPE, 'human', null, 'user.message', {
      messageId: 'm1',
      text: '@planner @implementer go',
      state: 'queued',
      mentions: ['planner', 'implementer'],
      targets: ['planner', 'implementer'],
      unknown: [],
    });
    await write(PLANNER_KEY, 'planner', 'turn-p', 'turn.start', {
      startedAt: '2026-09-02T12:00:00.000Z',
      trigger: { kind: 'human', messageId: 'm1' },
    });
    await write(ASSIGNMENT_SCOPE, 'human', null, 'user.message.delivered', {
      messageId: 'm1',
      agentId: 'planner',
      turnId: 'turn-p',
    });
    await write(IMPLEMENTER_KEY, 'implementer', 'turn-i', 'turn.start', {
      startedAt: '2026-09-02T12:00:01.000Z',
      trigger: { kind: 'human', messageId: 'm1' },
    });
    await write(ASSIGNMENT_SCOPE, 'human', null, 'user.message.delivered', {
      messageId: 'm1',
      agentId: 'implementer',
      turnId: 'turn-i',
    });
    await write(PLANNER_KEY, 'planner', 'turn-p', 'acp.update', {
      sessionUpdate: 'agent_message_chunk',
      messageId: 'pm1',
      content: { type: 'text', text: 'Done — over to you @implementer' },
    });
    await write(PLANNER_KEY, 'planner', 'turn-p', 'turn.end', {
      stopReason: 'end_turn',
      endedAt: '2026-09-02T12:00:05.000Z',
      durationMs: 5000,
    });
    await write(ASSIGNMENT_SCOPE, 'planner', null, 'handoff', {
      handoffId: 'h1',
      fromAgentId: 'planner',
      toAgentId: 'implementer',
      triggerItemId: 'turn-p:1',
      text: 'Done — over to you @implementer',
      hop: 1,
      budget: 4,
    });
    await write(ASSIGNMENT_SCOPE, 'system', null, 'route.notice', {
      level: 'warn',
      text: 'No agent @reviewer is attached to this assignment.',
    });
    await write(IMPLEMENTER_KEY, 'implementer', 'turn-i', 'turn.end', {
      stopReason: 'end_turn',
      endedAt: '2026-09-02T12:00:06.000Z',
      durationMs: 5000,
    });
  }

  it('rebuilds routing rows, handoffs and two agents’ turns identically', async () => {
    await seedTwoAgents();
    const liveRows = listChatItemRows(ASSIGNMENT_ID);
    // The routing rows really are there, authored by three different parties.
    expect(liveRows.filter((r) => r.type === 'handoff')).toHaveLength(1);
    expect(new Set(liveRows.map((r) => r.agent_id))).toEqual(
      new Set(['human', 'planner', 'implementer', 'system']),
    );
    const message = JSON.parse(liveRows.find((r) => r.type === 'user.message')!.json) as {
      state: string;
      deliveredTo: string[];
    };
    expect(message.state).toBe('sent');
    expect(message.deliveredTo).toEqual(['planner', 'implementer']);

    await rebuildChatIndex(assignmentDir, ASSIGNMENT_ID);
    expect(listChatItemRows(ASSIGNMENT_ID)).toEqual(liveRows);
  });

  it('replayItems reproduces the interleaved stream', async () => {
    await seedTwoAgents();
    const live = listChatItems(ASSIGNMENT_ID, { limit: 1000 });
    const events = await readEvents(chatLogPath(assignmentDir));
    expect(replayItems(events, ASSIGNMENT_ID)).toEqual(live);
  });
});

describe('chat schema v1 → v2 (Task 3)', () => {
  /**
   * The first chat migration: `chat_sessions.last_delivered_seq` (Decision 4).
   * The DDL declares it for a fresh database, so the step has to be guarded by
   * a `PRAGMA table_info` check rather than by the version alone.
   */
  it('adds last_delivered_seq to a v1 database and keeps its rows', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'syntaur-chat-v1-'));
    const dbPath = join(dir, 'syntaur.db');
    closeSessionDb();

    // Build a v1 database by hand: the pre-v2 chat DDL and the v1 version row.
    const Database = (await import('better-sqlite3')).default;
    const raw = new Database(dbPath);
    raw.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE chat_sessions (
        session_key         TEXT PRIMARY KEY,
        assignment_id       TEXT NOT NULL,
        project_slug        TEXT,
        assignment_slug     TEXT,
        agent_id            TEXT NOT NULL,
        harness             TEXT NOT NULL,
        acp_session_id      TEXT,
        adapter_version     TEXT,
        cwd                 TEXT,
        pid                 INTEGER,
        profile_json        TEXT,
        usage_snapshot_json TEXT,
        state               TEXT NOT NULL DEFAULT 'none',
        created_at          TEXT NOT NULL,
        last_turn_at        TEXT
      );
      INSERT INTO meta (key, value) VALUES ('chat_schema_version', '1');
      INSERT INTO chat_sessions (session_key, assignment_id, agent_id, harness, state, created_at)
        VALUES ('a1:claude', 'a1', 'claude', 'claude', 'idle', '2026-09-02T12:00:00.000Z');
    `);
    raw.close();

    const db = initSessionDb(dbPath);
    const columns = (db.prepare('PRAGMA table_info(chat_sessions)').all() as Array<{ name: string }>).map(
      (c) => c.name,
    );
    expect(columns).toContain('last_delivered_seq');
    expect(
      (db.prepare("SELECT value FROM meta WHERE key = 'chat_schema_version'").get() as { value: string })
        .value,
    ).toBe('2');
    // The existing row survives and defaults to the start of the log.
    expect(
      db.prepare("SELECT last_delivered_seq FROM chat_sessions WHERE session_key = 'a1:claude'").get(),
    ).toEqual({ last_delivered_seq: 0 });

    // Idempotent: a second init is a no-op, not a duplicate-column error.
    closeSessionDb();
    expect(() => initSessionDb(dbPath)).not.toThrow();
    closeSessionDb();
    await rm(dir, { recursive: true, force: true });
  });

  it('does not trip over a v2-shaped table whose version row still says v1', async () => {
    // The DDL runs (idempotently) BEFORE the migration, so a database whose
    // `chat_sessions` was recreated from the current DDL can reach the step
    // with the column already present. Without the PRAGMA guard the ALTER
    // fails with "duplicate column name" and rolls the whole init back.
    const dir = await mkdtemp(join(tmpdir(), 'syntaur-chat-v1-shape2-'));
    const dbPath = join(dir, 'syntaur.db');
    closeSessionDb();
    const Database = (await import('better-sqlite3')).default;
    const raw = new Database(dbPath);
    raw.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE chat_sessions (
        session_key         TEXT PRIMARY KEY,
        assignment_id       TEXT NOT NULL,
        project_slug        TEXT,
        assignment_slug     TEXT,
        agent_id            TEXT NOT NULL,
        harness             TEXT NOT NULL,
        acp_session_id      TEXT,
        adapter_version     TEXT,
        cwd                 TEXT,
        pid                 INTEGER,
        profile_json        TEXT,
        usage_snapshot_json TEXT,
        state               TEXT NOT NULL DEFAULT 'none',
        created_at          TEXT NOT NULL,
        last_turn_at        TEXT,
        last_delivered_seq  INTEGER NOT NULL DEFAULT 0
      );
      INSERT INTO meta (key, value) VALUES ('chat_schema_version', '1');
    `);
    raw.close();

    expect(() => initSessionDb(dbPath)).not.toThrow();
    expect(
      (
        getSessionDbForTest()
          .prepare("SELECT value FROM meta WHERE key = 'chat_schema_version'")
          .get() as { value: string }
      ).value,
    ).toBe('2');
    closeSessionDb();
    await rm(dir, { recursive: true, force: true });
  });

  it('declares the column on a fresh database without running the migration', () => {
    const columns = (
      getSessionDbForTest().prepare('PRAGMA table_info(chat_sessions)').all() as Array<{ name: string }>
    ).map((c) => c.name);
    expect(columns).toContain('last_delivered_seq');
  });
});
