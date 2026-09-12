import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import {
  migrateV2Command,
  V2_MIGRATED_MARKER,
  migrateSessionKey,
  migrateItemId,
  migrateSnoozeKey,
  migrateBackfillSourceKey,
} from '../commands/migrate-v2.js';
import {
  closeSessionDb,
  initSessionDb,
  resetSessionDb,
} from '../dashboard/session-db.js';
import { closeEventsDb, initEventsDb, resetEventsDb } from '../db/events-db.js';
import { closeUsageDb, initUsageDb, resetUsageDb } from '../db/usage-db.js';
import { renderProject } from '../templates/project.js';
import { renderTicket } from '../templates/ticket.js';
import { renderConfig } from '../templates/config.js';
import { parseTicketFolderName } from '../utils/ticket-folder.js';
import { REQUIRED_PROJECT_SCAFFOLD_FILES } from '../utils/project-scaffold.js';
import { buildCheckContext, closeCheckContext } from '../utils/doctor/context.js';
import { projectChecks } from '../utils/doctor/checks/project.js';

const UUID_P1A = '11111111-1111-4111-8111-111111111111';
const UUID_P1B = '22222222-2222-4222-8222-222222222222';
const UUID_P2A = '33333333-3333-4333-8333-333333333333';
const UUID_STANDALONE = '44444444-4444-4444-8444-444444444444';

const TS_P1A = '2026-01-01T00:00:00.000Z';
const TS_P1B = '2026-01-02T00:00:00.000Z';
const TS_P2A = '2026-01-03T00:00:00.000Z';
const TS_STANDALONE = '2026-01-04T00:00:00.000Z';

let home: string;
let priorHome: string | undefined;
let fixtureHash: string;

function ticketWithMeta(
  id: string,
  slug: string,
  project: string | null,
  created: string,
): string {
  const base = renderTicket({
    id,
    slug,
    title: slug,
    timestamp: created,
    priority: 'medium',
    dependsOn: [],
    links: [],
    project,
    status: 'draft',
  });
  return base.replace(/^created:.*$/m, `created: "${created}"`);
}

async function hashTree(dir: string): Promise<string> {
  const h = createHash('sha256');
  async function walk(p: string): Promise<void> {
    const entries = await readdir(p, { withFileTypes: true });
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name.startsWith('.')) continue;
      const full = join(p, e.name);
      h.update(full.slice(dir.length));
      if (e.isDirectory()) await walk(full);
      else h.update(await readFile(full));
    }
  }
  await walk(dir);
  return h.digest('hex');
}

async function buildFixture(root: string): Promise<void> {
  const projectsDir = resolve(root, 'projects');
  await mkdir(projectsDir, { recursive: true });

  const ts = '2026-06-01T00:00:00.000Z';
  for (const [slug, title] of [['p1', 'Project One'], ['p2', 'Project Two']] as const) {
    const projectDir = resolve(projectsDir, slug);
    await mkdir(resolve(projectDir, 'assignments'), { recursive: true });
    await writeFile(
      resolve(projectDir, 'project.md'),
      renderProject({
        id: `${slug}-project-id`,
        slug,
        title,
        timestamp: ts,
        prefix: 'XX',
        nextTicket: 99,
      }),
    );
  }

  await mkdir(resolve(projectsDir, 'p1', 'assignments', 'alpha-ticket'), { recursive: true });
  await writeFile(
    resolve(projectsDir, 'p1', 'assignments', 'alpha-ticket', 'assignment.md'),
    ticketWithMeta(UUID_P1A, 'alpha-ticket', 'p1', TS_P1A),
  );
  await mkdir(resolve(projectsDir, 'p1', 'assignments', 'beta-ticket'), { recursive: true });
  await writeFile(
    resolve(projectsDir, 'p1', 'assignments', 'beta-ticket', 'assignment.md'),
    ticketWithMeta(UUID_P1B, 'beta-ticket', 'p1', TS_P1B),
  );
  await mkdir(resolve(projectsDir, 'p2', 'assignments', 'gamma-ticket'), { recursive: true });
  await writeFile(
    resolve(projectsDir, 'p2', 'assignments', 'gamma-ticket', 'assignment.md'),
    ticketWithMeta(UUID_P2A, 'gamma-ticket', 'p2', TS_P2A),
  );

  const standaloneDir = resolve(root, 'assignments', UUID_STANDALONE);
  await mkdir(standaloneDir, { recursive: true });
  await writeFile(
    resolve(standaloneDir, 'assignment.md'),
    ticketWithMeta(UUID_STANDALONE, 'orphan', null, TS_STANDALONE),
  );

  const chatDir = resolve(projectsDir, 'p1', 'assignments', 'alpha-ticket', 'chat');
  await mkdir(chatDir, { recursive: true });
  await writeFile(
    resolve(chatDir, 'events.jsonl'),
    `${JSON.stringify({
      seq: 0,
      ts: TS_P1A,
      ticketId: UUID_P1A,
      assignmentId: UUID_P1A,
      agentId: 'claude',
      sessionKey: `${UUID_P1A}:claude`,
      turnId: null,
      kind: 'system',
      payload: { level: 'info', text: 'hello' },
    })}\n`,
  );

  await writeFile(
    resolve(root, 'inbox-snoozes.json'),
    JSON.stringify(
      {
        [`${UUID_P1A}:review`]: {
          until: '2099-01-01T00:00:00.000Z',
          fingerprint: 'fp-alpha',
          createdAt: TS_P1A,
        },
        [`review:${UUID_P1B}`]: {
          until: '2099-01-02T00:00:00.000Z',
          fingerprint: 'fp-beta',
          createdAt: TS_P1B,
        },
      },
      null,
      2,
    ) + '\n',
  );

  await writeFile(
    resolve(root, 'config.md'),
    renderConfig({ defaultProjectDir: '/old/elsewhere/projects' }),
  );

  const dbPath = resolve(root, 'syntaur.db');
  const db = new Database(dbPath);
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
  ).run('sess-1', UUID_P1A, 'p1', 'alpha-ticket', 'implement', TS_P1A);

  db.prepare(
    `INSERT INTO engagement
       (session_id, assignment_id, project_slug, assignment_slug, stage, started_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run('sess-empty', '', 'p1', 'beta-ticket', 'implement', TS_P1B);

  db.prepare(
    `INSERT INTO events (event_id, assignment_id, project_slug, at, actor, type, source_key)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run('evt-1', UUID_P1A, 'p1', TS_P1A, 'human', 'logged', null);

  db.prepare(
    `INSERT INTO events (event_id, assignment_id, project_slug, at, actor, type, source_key)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    'evt-bf-status',
    UUID_P1A,
    'p1',
    TS_P1A,
    'system',
    'status-change',
    `backfill:${UUID_P1A}:status:0`,
  );

  db.prepare(
    `INSERT INTO events (event_id, assignment_id, project_slug, at, actor, type, source_key)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    'evt-bf-plan',
    UUID_P1A,
    'p1',
    TS_P1A,
    'system',
    'plan-approval',
    `backfill:${UUID_P1A}:plan-approval`,
  );

  db.prepare(
    `INSERT INTO usage_events (session_id, model, tool, event_ts, project_slug, assignment_slug, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run('sess-standalone', 'claude-opus', 'claude', TS_STANDALONE, '', UUID_STANDALONE, TS_STANDALONE);

  db.prepare(
    `INSERT INTO usage_events (session_id, model, tool, event_ts, project_slug, assignment_slug, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    'sess-orphan',
    'claude-opus',
    'claude',
    TS_P1A,
    'p1',
    'deleted-ticket',
    TS_P1A,
  );

  db.prepare(
    `INSERT INTO usage_daily (day, tool, model, project_slug, assignment_slug, computed_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run('2026-01-02', 'claude', 'claude-opus', 'p1', 'deleted-ticket', TS_P1B);

  db.prepare(
    `INSERT INTO chat_sessions (session_key, assignment_id, project_slug, assignment_slug, agent_id, harness, state, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(`${UUID_P1A}:claude`, UUID_P1A, 'p1', 'alpha-ticket', 'claude', 'claude', 'idle', TS_P1A);

  db.prepare(
    `INSERT INTO chat_items (item_id, assignment_id, session_key, agent_id, type, ts, seq_first, seq_last, sealed, json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    `session:${UUID_P1A}:claude:0`,
    UUID_P1A,
    `${UUID_P1A}:claude`,
    'claude',
    'user.message',
    TS_P1A,
    1,
    1,
    0,
    '{}',
  );

  db.prepare(
    `INSERT INTO usage_events (session_id, model, tool, event_ts, project_slug, assignment_slug, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run('sess-1', 'claude-opus', 'claude', TS_P1A, 'p1', 'alpha-ticket', TS_P1A);

  db.prepare(
    `INSERT INTO usage_daily (day, tool, model, project_slug, assignment_slug, computed_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run('2026-01-01', 'claude', 'claude-opus', 'p1', 'alpha-ticket', TS_P1A);

  db.prepare(
    `INSERT INTO usage_daily (day, tool, model, project_slug, assignment_slug, input_tokens, total_tokens, computed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run('2026-01-04', 'claude', 'claude-opus', '', UUID_STANDALONE, 10, 10, TS_STANDALONE);

  db.prepare(
    `INSERT INTO usage_daily (day, tool, model, project_slug, assignment_slug, input_tokens, total_tokens, computed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run('2026-01-04', 'claude', 'claude-opus', '', 'orphan', 20, 20, TS_STANDALONE);

  db.prepare(
    `INSERT INTO usage_events (session_id, model, tool, event_ts, project_slug, assignment_slug, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run('sess-unattributed', 'claude-opus', 'claude', TS_P1A, '', '', TS_P1A);

  db.close();
}

beforeEach(async () => {
  priorHome = process.env.SYNTAUR_HOME;
  home = await mkdtemp(join(tmpdir(), 'syntaur-migrate-v2-'));
  process.env.SYNTAUR_HOME = home;
  resetSessionDb();
  resetEventsDb();
  resetUsageDb();
  await buildFixture(home);
  fixtureHash = await hashTree(home);
});

afterEach(async () => {
  closeSessionDb();
  closeEventsDb();
  closeUsageDb();
  resetSessionDb();
  resetEventsDb();
  resetUsageDb();
  if (priorHome === undefined) delete process.env.SYNTAUR_HOME;
  else process.env.SYNTAUR_HOME = priorHome;
  await rm(home, { recursive: true, force: true });
});

describe('migrate v2 key helpers', () => {
  it('detects id-prefixed folder names for half-applied guard', () => {
    expect(parseTicketFolderName('SYN-1-half-applied')).toEqual({
      id: 'SYN-1',
      slug: 'half-applied',
    });
  });
  it('migrates session keys and item ids', () => {
    const uuidToId = new Map([[UUID_P1A, 'P1-1'], [UUID_P1B, 'P1-2']]);
    const itemMap = new Map<string, string>();
    expect(migrateSessionKey(`${UUID_P1A}:claude`, uuidToId)).toBe('P1-1~claude');
    expect(migrateSessionKey(`${UUID_P1A}:@assignment`, uuidToId)).toBe('P1-1~@ticket');
    expect(migrateItemId(`session:${UUID_P1A}:claude:0`, uuidToId, itemMap)).toBe(
      'session~P1-1~claude~0',
    );
    expect(migrateItemId('replay:1:2', uuidToId, itemMap)).toBe('replay~1~2');
    expect(migrateSnoozeKey(`${UUID_P1A}:review`, uuidToId, itemMap)).toBe('P1-1~review');
    expect(migrateSnoozeKey(`review:${UUID_P1B}`, uuidToId, itemMap)).toBe('P1-2~review');
  });

  it('migrates backfill source keys from colon to tilde form', () => {
    const uuidToId = new Map([[UUID_P1A, 'P1-1']]);
    expect(migrateBackfillSourceKey(`backfill:${UUID_P1A}:status:0`, uuidToId)).toBe(
      'backfill~P1-1~status~0',
    );
    expect(migrateBackfillSourceKey(`backfill:${UUID_P1A}:plan-approval`, uuidToId)).toBe(
      'backfill~P1-1~plan-approval',
    );
  });
});

const MIGRATION_TABLES = [
  'meta',
  'sessions',
  'engagement',
  'events',
  'chat_sessions',
  'chat_items',
  'usage_events',
  'usage_daily',
] as const;

function tableRowCounts(dbPath: string): Record<string, number> {
  const db = new Database(dbPath, { readonly: true });
  const counts: Record<string, number> = {};
  for (const table of MIGRATION_TABLES) {
    counts[table] = (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  }
  db.close();
  return counts;
}

describe('migrateV2Command', () => {
  it('dry-run leaves the fixture byte-identical and prints [dry-run] transcript', async () => {
    const { lines } = await migrateV2Command({ root: home, apply: false });
    expect(await hashTree(home)).toBe(fixtureHash);
    expect(lines.some((l) => l.startsWith('[dry-run] project p1: prefix P1,'))).toBe(true);
    expect(lines.some((l) => l.includes('alpha-ticket → P1-1-alpha-ticket'))).toBe(true);
    expect(lines.some((l) => l === `[dry-run] UUID ${UUID_P1A} → P1-1`)).toBe(true);
    expect(lines.some((l) => l.includes('standalone: 1 tickets → scratch'))).toBe(true);
    expect(lines.some((l) => l.includes(`${UUID_STANDALONE} → SCR-1-orphan`))).toBe(true);
    expect(
      lines.some((l) =>
        l.includes('unmatched usage_events rows: 1 (slugs without a ticket folder: deleted-ticket)'),
      ),
    ).toBe(true);
    expect(
      lines.some((l) =>
        l.includes('unmatched usage_daily rows: 1 (slugs without a ticket folder: deleted-ticket)'),
      ),
    ).toBe(true);
    expect(lines.some((l) => l.includes('re-keyed events.source_key: 2'))).toBe(true);
    expect(lines.some((l) => l.includes('merged usage_daily rows: 1'))).toBe(true);
    expect(lines.some((l) => l.includes('unattributed usage_events rows: 1'))).toBe(true);
    expect(lines.some((l) => l.includes('totals: 3 projects, 4 tickets'))).toBe(true);
    expect(lines.every((l) => l.startsWith('[dry-run]'))).toBe(true);
  });

  it('apply renames folders, assigns ids, re-keys db, and writes marker', async () => {
    const beforeCounts = tableRowCounts(resolve(home, 'syntaur.db'));
    await migrateV2Command({ root: home, apply: true });
    const afterCounts = tableRowCounts(resolve(home, 'syntaur.db'));
    expect(afterCounts.usage_daily).toBe(beforeCounts.usage_daily - 1);
    const { usage_daily: _ud, ...beforeRest } = beforeCounts;
    const { usage_daily: _ud2, ...afterRest } = afterCounts;
    expect(afterRest).toEqual(beforeRest);

    expect(await fileExists(resolve(home, V2_MIGRATED_MARKER))).toBe(true);
    expect(await fileExists(resolve(home, 'projects', 'p1', 'tickets', 'P1-1-alpha-ticket', 'ticket.md'))).toBe(
      true,
    );
    expect(
      await fileExists(resolve(home, 'projects', 'p1', 'assignments')),
    ).toBe(false);
    expect(
      await fileExists(resolve(home, 'projects', 'scratch', 'tickets', 'SCR-1-orphan', 'ticket.md')),
    ).toBe(true);
    expect(await fileExists(resolve(home, 'projects', 'scratch', 'project.md'))).toBe(true);
    const scratchProject = await readFile(resolve(home, 'projects', 'scratch', 'project.md'), 'utf-8');
    expect(scratchProject).toContain('prefix: SCR');
    expect(scratchProject).toContain('nextTicket:');
    expect(scratchProject).toContain('defaultTemplate: feature');
    const scratchDir = resolve(home, 'projects', 'scratch');
    for (const file of REQUIRED_PROJECT_SCAFFOLD_FILES) {
      expect(await fileExists(resolve(scratchDir, file))).toBe(true);
    }
    const scratchIndex = await readFile(resolve(scratchDir, '_index-tickets.md'), 'utf-8');
    expect(scratchIndex).toContain('SCR-1-orphan');
    expect(scratchIndex).toContain('total: 1');
    const scratchManifest = await readFile(resolve(scratchDir, 'manifest.md'), 'utf-8');
    expect(scratchManifest).toContain('_index-tickets.md');
    const doctorCtx = await buildCheckContext();
    const requiredCheck = projectChecks.find((c) => c.id === 'project.required-files-present')!;
    const requiredResult = await requiredCheck.run(doctorCtx);
    closeCheckContext(doctorCtx);
    const requiredIssues = Array.isArray(requiredResult) ? requiredResult : [requiredResult];
    const scratchErrors = requiredIssues.filter(
      (r) => r.status === 'error' && r.detail?.includes(`${scratchDir}`),
    );
    expect(scratchErrors).toHaveLength(0);
    expect(await fileExists(resolve(home, 'assignments'))).toBe(false);
    expect(await fileExists(resolve(home, 'tickets'))).toBe(false);

    const ticketMd = await readFile(
      resolve(home, 'projects', 'p1', 'tickets', 'P1-1-alpha-ticket', 'ticket.md'),
      'utf-8',
    );
    expect(ticketMd).toContain('id: P1-1');

    const eventsPath = resolve(
      home,
      'projects',
      'p1',
      'tickets',
      'P1-1-alpha-ticket',
      'chat',
      'events.jsonl',
    );
    const eventsLines = (await readFile(eventsPath, 'utf-8'))
      .split('\n')
      .filter((line) => line.trim().length > 0);
    expect(eventsLines.length).toBeGreaterThan(0);
    for (const line of eventsLines) {
      const event = JSON.parse(line) as Record<string, unknown>;
      expect(event).toHaveProperty('ticketId', 'P1-1');
      expect(event).not.toHaveProperty('assignmentId');
      expect(event.sessionKey).toBe('P1-1~claude');
    }

    const snoozes = JSON.parse(await readFile(resolve(home, 'inbox-snoozes.json'), 'utf-8')) as Record<
      string,
      unknown
    >;
    expect(Object.keys(snoozes).sort()).toEqual(['P1-1~review', 'P1-2~review']);

    const dbPath = resolve(home, 'syntaur.db');
    resetSessionDb();
    resetEventsDb();
    resetUsageDb();
    const sessionDb = initSessionDb(dbPath);
    const eventsDb = initEventsDb(dbPath);
    const usageDb = initUsageDb(dbPath);

    const engagement = sessionDb
      .prepare('SELECT ticket_id FROM engagement WHERE session_id = ?')
      .get('sess-1') as { ticket_id: string };
    expect(engagement.ticket_id).toBe('P1-1');

    const engagementSlug = sessionDb
      .prepare('SELECT ticket_id FROM engagement WHERE session_id = ?')
      .get('sess-empty') as { ticket_id: string };
    expect(engagementSlug.ticket_id).toBe('P1-2');

    const event = eventsDb
      .prepare('SELECT ticket_id FROM events WHERE event_id = ?')
      .get('evt-1') as { ticket_id: string };
    expect(event.ticket_id).toBe('P1-1');

    const backfillStatus = eventsDb
      .prepare('SELECT source_key FROM events WHERE event_id = ?')
      .get('evt-bf-status') as { source_key: string };
    expect(backfillStatus.source_key).toBe('backfill~P1-1~status~0');

    const backfillPlan = eventsDb
      .prepare('SELECT source_key FROM events WHERE event_id = ?')
      .get('evt-bf-plan') as { source_key: string };
    expect(backfillPlan.source_key).toBe('backfill~P1-1~plan-approval');

    expect(
      (eventsDb.prepare("SELECT count(*) AS n FROM events WHERE source_key LIKE '%:%'").get() as {
        n: number;
      }).n,
    ).toBe(0);

    const chatSession = sessionDb
      .prepare('SELECT ticket_id, session_key FROM chat_sessions WHERE session_key = ?')
      .get('P1-1~claude') as { ticket_id: string; session_key: string };
    expect(chatSession.ticket_id).toBe('P1-1');
    expect(chatSession.session_key).toBe('P1-1~claude');

    const usage = usageDb
      .prepare('SELECT ticket_id FROM usage_events WHERE session_id = ?')
      .get('sess-1') as { ticket_id: string };
    expect(usage.ticket_id).toBe('P1-1');

    const standaloneUsage = usageDb
      .prepare('SELECT ticket_id FROM usage_events WHERE session_id = ?')
      .get('sess-standalone') as { ticket_id: string };
    expect(standaloneUsage.ticket_id).toBe('SCR-1');

    const orphanUsage = usageDb
      .prepare('SELECT ticket_id FROM usage_events WHERE session_id = ?')
      .get('sess-orphan') as { ticket_id: string };
    expect(orphanUsage.ticket_id).toBe('deleted-ticket');

    const mergedDaily = usageDb
      .prepare(
        `SELECT ticket_id, input_tokens, total_tokens FROM usage_daily
         WHERE day = ? AND tool = ? AND model = ? AND project_slug = ?`,
      )
      .get('2026-01-04', 'claude', 'claude-opus', '') as {
      ticket_id: string;
      input_tokens: number;
      total_tokens: number;
    };
    expect(mergedDaily.ticket_id).toBe('SCR-1');
    expect(mergedDaily.input_tokens).toBe(30);
    expect(mergedDaily.total_tokens).toBe(30);

    expect(
      (sessionDb
        .prepare("SELECT count(*) AS n FROM chat_sessions WHERE session_key LIKE '%:%'")
        .get() as { n: number }).n,
    ).toBe(0);
    expect(
      (sessionDb
        .prepare("SELECT count(*) AS n FROM chat_items WHERE item_id LIKE '%:%'")
        .get() as { n: number }).n,
    ).toBe(0);
    expect(
      (sessionDb
        .prepare("SELECT count(*) AS n FROM chat_items WHERE session_key LIKE '%:%'")
        .get() as { n: number }).n,
    ).toBe(0);

    closeSessionDb();
    closeEventsDb();
    closeUsageDb();
  });

  it('refuses second apply when marker exists', async () => {
    await migrateV2Command({ root: home, apply: true });
    await expect(migrateV2Command({ root: home, apply: true })).rejects.toThrow(/already completed/);
  });

  it('refuses apply when id-prefixed folders exist without marker', async () => {
    const halfDir = resolve(home, 'projects', 'p1', 'assignments', 'SYN-1-half-applied');
    await mkdir(halfDir, { recursive: true });
    await expect(migrateV2Command({ root: home, apply: true })).rejects.toThrow(/half-applied/);
  });

  it('aborts with restore message, leaves no marker, and keeps files unchanged on database failure', async () => {
    const hashBefore = await hashTree(home);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await expect(
        migrateV2Command({
          root: home,
          apply: true,
          injectDbFailure: () => {
            throw new Error('injected');
          },
        }),
      ).rejects.toThrow(/Migration aborted\. Restore from backup at/);
      expect(await fileExists(resolve(home, V2_MIGRATED_MARKER))).toBe(false);
      expect(await hashTree(home)).toBe(hashBefore);
      expect(
        await fileExists(resolve(home, 'projects', 'p1', 'assignments', 'alpha-ticket')),
      ).toBe(true);
    } finally {
      logSpy.mockRestore();
    }
  });
});

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
