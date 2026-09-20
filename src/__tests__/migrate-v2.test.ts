import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, stat, cp } from 'node:fs/promises';
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
  mapTicketRef,
  rekeyDatabase,
  readMarkerSteps,
  pendingMigrationSteps,
  V2_TICKET_FIELD_ORDER,
  listTopLevelFrontmatterKeys,
} from '../commands/migrate-v2.js';
import { parseTicketFrontmatter } from '../lifecycle/frontmatter.js';
import { parseTicketFull } from '../dashboard/parser.js';
import { buildShow } from '../ticket-templates/show.js';
import { BUILTIN_TEMPLATE_IDS, seedMissingBuiltins } from '../ticket-templates/builtins.js';
import { buildCheckContext, closeCheckContext } from '../utils/doctor/context.js';
import { ticketChecks } from '../utils/doctor/checks/ticket.js';
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
    depends_on: [],
    links: [],
    project,
    status: 'draft',
    template: 'feature',
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

  it('mapTicketRef resolves within project and warns on cross-project ambiguity', () => {
    const maps = {
      uuidToId: new Map<string, string>(),
      slugToId: new Map([['p1:shared', 'P1-1'], ['p2:shared', 'P2-1']]),
      projectSlugToId: new Map([
        ['p1', new Map([['shared', 'P1-1']])],
        ['p2', new Map([['shared', 'P2-1']])],
      ]),
      itemIdMap: new Map<string, string>(),
      duplicateStandaloneSlugs: new Set<string>(),
      refWarnings: [] as string[],
    };
    expect(mapTicketRef('shared', 'p1', maps)).toBe('P1-1');
    expect(mapTicketRef('shared', 'p2', maps)).toBe('P2-1');
    expect(mapTicketRef('shared', 'p9', maps)).toBe('shared');
    expect(maps.refWarnings.some((w) => w.includes('ambiguous ticket reference "shared"'))).toBe(
      true,
    );
    maps.refWarnings.length = 0;
    expect(mapTicketRef('only-here', null, {
      ...maps,
      slugToId: new Map([['p1:only-here', 'P1-9']]),
      projectSlugToId: new Map([['p1', new Map([['only-here', 'P1-9']])]]),
    })).toBe('P1-9');
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
    expect(
      lines.some((l) => l === `[dry-run] config defaultProjectDir → ${resolve(home, 'projects')}`),
    ).toBe(true);
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
    expect(await fileExists(resolve(scratchDir, 'manifest.md'))).toBe(false);
    expect(await fileExists(resolve(scratchDir, '_index-tickets.md'))).toBe(false);
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

  it('dry-run prints templates step counts without writing files', async () => {
    const { lines } = await migrateV2Command({ root: home, apply: false });
    expect(await hashTree(home)).toBe(fixtureHash);
    expect(lines.some((l) => l.includes('templates: seeded'))).toBe(true);
    expect(lines.some((l) => l === '[dry-run] template legacy: 4 tickets')).toBe(true);
    expect(lines.some((l) => l.includes('statuses: 4 tickets mapped'))).toBe(true);
  });

  it('apply runs rename-ids then templates then statuses and writes a step ledger', async () => {
    await migrateV2Command({ root: home, apply: true });
    const marker = await readFile(resolve(home, V2_MIGRATED_MARKER), 'utf-8');
    expect(marker).toContain('rename-ids ');
    expect(marker).toContain('templates ');
    expect(marker).toContain('statuses ');
    expect(pendingMigrationSteps(await readMarkerSteps(resolve(home, V2_MIGRATED_MARKER)))).toEqual(
      [],
    );
    expect(await fileExists(resolve(home, 'templates', 'feature', 'template.md'))).toBe(true);
  });

  it('bare-timestamp marker leaves templates, statuses, and derived pending; one apply runs all three', async () => {
    await migrateV2Command({ root: home, apply: true });
    const bareTs = '2026-09-12T12:46:05.342Z';
    await writeFile(resolve(home, V2_MIGRATED_MARKER), `${bareTs}\n`);
    expect(pendingMigrationSteps(await readMarkerSteps(resolve(home, V2_MIGRATED_MARKER)))).toEqual(
      ['templates', 'statuses', 'derived'],
    );

    const hashBefore = await hashTree(home);
    const { lines } = await migrateV2Command({ root: home, apply: true });
    expect(await hashTree(home)).not.toBe(hashBefore);
    expect(lines.some((l) => l.startsWith('[apply] templates:'))).toBe(true);
    expect(lines.some((l) => l.startsWith('[apply] statuses:'))).toBe(true);
    expect(lines.some((l) => l.includes('derived:'))).toBe(true);
    expect(lines.some((l) => l.includes('project p1: prefix'))).toBe(false);
    const marker = await readFile(resolve(home, V2_MIGRATED_MARKER), 'utf-8');
    expect(marker).toContain(bareTs);
    expect(marker).toContain('templates ');
    expect(marker).toContain('statuses ');
    expect(marker).toContain('derived ');

    await expect(migrateV2Command({ root: home, apply: true })).rejects.toThrow(
      /already completed/,
    );
  });

  it('aborts with restore message, leaves no marker, and keeps files unchanged on database failure', async () => {
    const configBefore = await readFile(resolve(home, 'config.md'), 'utf-8');
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
      expect(await readFile(resolve(home, 'config.md'), 'utf-8')).toBe(configBefore);
      expect(
        await fileExists(resolve(home, 'projects', 'p1', 'assignments', 'alpha-ticket')),
      ).toBe(true);
    } finally {
      logSpy.mockRestore();
    }
  });
});

function v1TicketMd(opts: {
  id: string;
  slug: string;
  project: string;
  type?: string;
  dependsOn?: string[];
  planApproval?: { file: string; digest: string; by: string; at: string } | null;
}): string {
  const dependsOn =
    opts.dependsOn === undefined
      ? 'dependsOn: []'
      : opts.dependsOn.length === 0
        ? 'dependsOn: []'
        : `dependsOn:\n${opts.dependsOn.map((d) => `  - ${d}`).join('\n')}`;
  const planApproval = opts.planApproval
    ? `planApproval:
  file: ${opts.planApproval.file}
  digest: ${opts.planApproval.digest}
  by: ${opts.planApproval.by}
  at: "${opts.planApproval.at}"`
    : '';
  const typeLine = opts.type ? `type: ${opts.type}` : 'type: feature';
  return `---
id: ${opts.id}
slug: ${opts.slug}
title: ${opts.slug}
project: ${opts.project}
${typeLine}
status: draft
priority: medium
created: "2026-01-01T00:00:00Z"
updated: "2026-01-01T00:00:00Z"
${dependsOn}
links: []
${planApproval}
---

## Objective

Test ticket.
`;
}

describe('migrate v2 templates step', () => {
  let tplHome: string;

  beforeEach(async () => {
    tplHome = await mkdtemp(join(tmpdir(), 'syntaur-migrate-templates-'));
    process.env.SYNTAUR_HOME = tplHome;
    const projectDir = resolve(tplHome, 'projects', 'demo', 'tickets', 'DEM-1-alpha');
    await mkdir(projectDir, { recursive: true });
    await mkdir(resolve(tplHome, 'projects', 'demo'), { recursive: true });
    await writeFile(
      resolve(tplHome, 'projects', 'demo', 'project.md'),
      renderProject({
        id: 'demo-id',
        slug: 'demo',
        title: 'Demo',
        timestamp: '2026-01-01T00:00:00Z',
        prefix: 'DEM',
        nextTicket: 2,
      }),
    );
  });

  afterEach(async () => {
    await rm(tplHome, { recursive: true, force: true });
  });

  it('rewrites depends_on, plan block, template legacy and drops type per ticket', async () => {
    const digest = createHash('sha256').update('# Plan\n', 'utf-8').digest('hex');
    const ticketDir = resolve(tplHome, 'projects', 'demo', 'tickets', 'DEM-1-alpha');
    await writeFile(
      resolve(ticketDir, 'ticket.md'),
      v1TicketMd({
        id: 'DEM-1',
        slug: 'alpha',
        project: 'demo',
        type: 'bug',
        dependsOn: ['DEM-0'],
        planApproval: {
          file: 'plan.md',
          digest,
          by: 'human',
          at: '2026-09-01T00:00:00Z',
        },
      }),
    );
    await writeFile(resolve(ticketDir, 'plan.md'), '# Plan\n');

    await writeFile(resolve(tplHome, V2_MIGRATED_MARKER), '2026-09-12T12:46:05.342Z\n');
    await migrateV2Command({ root: tplHome, apply: true });

    const ticketMd = await readFile(resolve(ticketDir, 'ticket.md'), 'utf-8');
    expect(ticketMd.indexOf('project: demo\n')).toBeGreaterThan(-1);
    expect(ticketMd).toMatch(/project: demo\ntemplate: legacy/);
    expect(ticketMd).toContain('depends_on:\n  - DEM-0');
    expect(ticketMd).not.toContain('dependsOn:');
    expect(ticketMd).not.toContain('type:');
    expect(ticketMd).not.toContain('planApproval:');
    expect(ticketMd).toContain('plan:\n  file: plan.md');
    expect(ticketMd).toContain(`approvedDigest: ${digest}`);
    expect(ticketMd).toContain('status: backlog');
  });

  it('drops superseded plan approvals when a newer plan revision exists', async () => {
    const oldDigest = createHash('sha256').update('# Old\n', 'utf-8').digest('hex');
    const ticketDir = resolve(tplHome, 'projects', 'demo', 'tickets', 'DEM-1-alpha');
    await writeFile(
      resolve(ticketDir, 'ticket.md'),
      v1TicketMd({
        id: 'DEM-1',
        slug: 'alpha',
        project: 'demo',
        planApproval: {
          file: 'plan.md',
          digest: oldDigest,
          by: 'human',
          at: '2026-09-01T00:00:00Z',
        },
      }),
    );
    await writeFile(resolve(ticketDir, 'plan.md'), '# Old\n');
    await writeFile(resolve(ticketDir, 'plan-v2.md'), '# New\n');

    await writeFile(resolve(tplHome, V2_MIGRATED_MARKER), 'rename-ids 2026-09-12T12:46:05.342Z\n');
    const { lines } = await migrateV2Command({ root: tplHome, apply: true });
    const ticketMd = await readFile(resolve(ticketDir, 'ticket.md'), 'utf-8');
    expect(ticketMd).toContain('file: plan-v2.md');
    expect(ticketMd).toContain('approvedDigest: null');
    expect(
      lines.some((l) => l.includes('1 superseded approvals dropped')),
    ).toBe(true);
  });

  it('isolates --root copies from the default home', async () => {
    const copyHome = await mkdtemp(join(tmpdir(), 'syntaur-migrate-root-copy-'));
    await cp(tplHome, copyHome, { recursive: true });
    const ticketDir = resolve(copyHome, 'projects', 'demo', 'tickets', 'DEM-1-alpha');
    await writeFile(
      resolve(ticketDir, 'ticket.md'),
      v1TicketMd({ id: 'DEM-1', slug: 'alpha', project: 'demo', type: 'chore' }),
    );
    const originalProjects = resolve(tplHome, 'projects');
    await writeFile(
      resolve(copyHome, 'config.md'),
      renderConfig({ defaultProjectDir: originalProjects }),
    );
    await writeFile(resolve(copyHome, V2_MIGRATED_MARKER), '2026-09-12T12:46:05.342Z\n');
    const { lines } = await migrateV2Command({ root: copyHome, apply: true });
    expect(lines.some((l) => l === `[apply] config defaultProjectDir → ${resolve(copyHome, 'projects')}`)).toBe(
      true,
    );
    expect(await fileExists(resolve(copyHome, 'templates', 'legacy', 'template.md'))).toBe(true);
    const ticketMd = await readFile(resolve(ticketDir, 'ticket.md'), 'utf-8');
    expect(ticketMd).toContain('template: legacy');
    const configMd = await readFile(resolve(copyHome, 'config.md'), 'utf-8');
    expect(configMd).toContain(`defaultProjectDir: ${resolve(copyHome, 'projects')}`);
    expect(configMd).not.toContain(originalProjects);
    await rm(copyHome, { recursive: true, force: true });
  });

  it('dry-run --root prints config rewrite before templates-only step', async () => {
    const copyHome = await mkdtemp(join(tmpdir(), 'syntaur-migrate-root-dry-'));
    await cp(tplHome, copyHome, { recursive: true });
    await writeFile(
      resolve(copyHome, 'config.md'),
      renderConfig({ defaultProjectDir: resolve(tplHome, 'projects') }),
    );
    await writeFile(resolve(copyHome, V2_MIGRATED_MARKER), '2026-09-12T12:46:05.342Z\n');
    const hashBefore = await hashTree(copyHome);
    const { lines } = await migrateV2Command({ root: copyHome, apply: false });
    expect(await hashTree(copyHome)).toBe(hashBefore);
    expect(lines.some((l) => l === `[dry-run] config defaultProjectDir → ${resolve(copyHome, 'projects')}`)).toBe(
      true,
    );
    const configMd = await readFile(resolve(copyHome, 'config.md'), 'utf-8');
    expect(configMd).toContain(resolve(tplHome, 'projects'));
    await rm(copyHome, { recursive: true, force: true });
  });
});

const UUID_DUP_SA1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa0001';
const UUID_DUP_SA2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbb0002';
const UUID_DUP_P1S = 'cccccccc-cccc-4ccc-8ccc-cccccccc0003';
const UUID_DUP_P2S = 'dddddddd-dddd-4ddd-8ddd-dddddddd0004';

async function buildDuplicateSlugFixture(root: string): Promise<void> {
  const projectsDir = resolve(root, 'projects');
  await mkdir(projectsDir, { recursive: true });
  const ts = '2026-06-01T00:00:00.000Z';

  for (const [slug, title, prefix] of [
    ['p1', 'Project One', 'P1'],
    ['p2', 'Project Two', 'P2'],
  ] as const) {
    const projectDir = resolve(projectsDir, slug);
    await mkdir(resolve(projectDir, 'assignments'), { recursive: true });
    await writeFile(
      resolve(projectDir, 'project.md'),
      renderProject({
        id: `${slug}-project-id`,
        slug,
        title,
        timestamp: ts,
        prefix,
        nextTicket: 99,
      }),
    );
  }

  await mkdir(resolve(projectsDir, 'p1', 'assignments', 'shared-ticket'), { recursive: true });
  await writeFile(
    resolve(projectsDir, 'p1', 'assignments', 'shared-ticket', 'assignment.md'),
    ticketWithMeta(UUID_DUP_P1S, 'shared', 'p1', '2026-01-03T00:00:00.000Z'),
  );
  await mkdir(resolve(projectsDir, 'p2', 'assignments', 'shared-ticket'), { recursive: true });
  await writeFile(
    resolve(projectsDir, 'p2', 'assignments', 'shared-ticket', 'assignment.md'),
    ticketWithMeta(UUID_DUP_P2S, 'shared', 'p2', '2026-01-04T00:00:00.000Z'),
  );

  for (const [uuid, slug, created] of [
    [UUID_DUP_SA1, 'test', '2026-01-01T00:00:00.000Z'],
    [UUID_DUP_SA2, 'test', '2026-01-02T00:00:00.000Z'],
  ] as const) {
    const dir = resolve(root, 'assignments', uuid);
    await mkdir(dir, { recursive: true });
    await writeFile(resolve(dir, 'assignment.md'), ticketWithMeta(uuid, slug, null, created));
  }

  await writeFile(resolve(root, 'config.md'), renderConfig({ defaultProjectDir: '/old/projects' }));

  const dbPath = resolve(root, 'syntaur.db');
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
    INSERT INTO meta (key, value) VALUES ('schema_version', '12');
    INSERT INTO meta (key, value) VALUES ('engagement_schema_version', '1');

    CREATE TABLE sessions (
      session_id TEXT PRIMARY KEY,
      agent TEXT NOT NULL DEFAULT 'claude',
      started TEXT NOT NULL,
      ended TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      path TEXT,
      description TEXT,
      transcript_path TEXT,
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

    CREATE TABLE usage_events (
      session_id TEXT NOT NULL,
      model TEXT NOT NULL,
      tool TEXT NOT NULL,
      event_ts TEXT NOT NULL,
      project_slug TEXT NOT NULL DEFAULT '',
      assignment_slug TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL,
      PRIMARY KEY (session_id, model)
    );

    CREATE TABLE usage_daily (
      day TEXT NOT NULL,
      tool TEXT NOT NULL,
      model TEXT NOT NULL,
      project_slug TEXT NOT NULL DEFAULT '',
      assignment_slug TEXT NOT NULL DEFAULT '',
      computed_at TEXT NOT NULL,
      PRIMARY KEY (day, tool, model, project_slug, assignment_slug)
    );
  `);

  const eng = [
    ['sess-sa1-uuid', UUID_DUP_SA1, '', 'test'],
    ['sess-sa2-uuid', UUID_DUP_SA2, '', 'test'],
    ['sess-sa1-slug', '', '', 'test'],
    ['sess-sa2-slug', '', '', 'test'],
    ['sess-p1-shared-uuid', UUID_DUP_P1S, 'p1', 'shared'],
    ['sess-p2-shared-uuid', UUID_DUP_P2S, 'p2', 'shared'],
    ['sess-p1-shared-slug', '', 'p1', 'shared'],
    ['sess-p2-shared-slug', '', 'p2', 'shared'],
  ] as const;
  for (const [sessionId, assignmentId, projectSlug, assignmentSlug] of eng) {
    db.prepare(
      `INSERT INTO engagement (session_id, assignment_id, project_slug, assignment_slug, started_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(sessionId, assignmentId, projectSlug, assignmentSlug, '2026-01-01T00:00:00.000Z');
  }

  const usageRows = [
    ['ue-sa1-uuid', UUID_DUP_SA1, '', 'test'],
    ['ue-sa2-uuid', UUID_DUP_SA2, '', 'test'],
    ['ue-sa1-slug', '', '', 'test'],
    ['ue-sa2-slug', '', '', 'test'],
    ['ue-p1-shared-uuid', UUID_DUP_P1S, 'p1', 'shared'],
    ['ue-p2-shared-uuid', UUID_DUP_P2S, 'p2', 'shared'],
    ['ue-p1-shared-slug', '', 'p1', 'shared'],
    ['ue-p2-shared-slug', '', 'p2', 'shared'],
  ] as const;
  for (const [sessionId, ticketRef, projectSlug, slugVal] of usageRows) {
    db.prepare(
      `INSERT INTO usage_events (session_id, model, tool, event_ts, project_slug, assignment_slug, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(sessionId, 'claude-opus', 'claude', '2026-01-01T00:00:00.000Z', projectSlug, ticketRef || slugVal, '2026-01-01T00:00:00.000Z');
  }

  const dailyRows = [
    ['2026-01-01', UUID_DUP_SA1, '', 'test'],
    ['2026-01-02', UUID_DUP_SA2, '', 'test'],
    ['2026-01-03', '', '', 'test', 'ue-sa1-slug-daily'],
    ['2026-01-04', '', '', 'test', 'ue-sa2-slug-daily'],
    ['2026-01-05', UUID_DUP_P1S, 'p1', 'shared'],
    ['2026-01-06', UUID_DUP_P2S, 'p2', 'shared'],
    ['2026-01-07', '', 'p1', 'shared', 'ud-p1-shared-slug'],
    ['2026-01-08', '', 'p2', 'shared', 'ud-p2-shared-slug'],
  ] as const;
  for (const row of dailyRows) {
    const [day, ticketRef, projectSlug, slugVal, toolSuffix] = row;
    db.prepare(
      `INSERT INTO usage_daily (day, tool, model, project_slug, assignment_slug, computed_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      day,
      `claude-${toolSuffix ?? ticketRef.slice(0, 8)}`,
      'claude-opus',
      projectSlug,
      ticketRef || slugVal,
      '2026-01-01T00:00:00.000Z',
    );
  }
  db.close();
}

function v2StatusTicketMd(opts: {
  id: string;
  slug: string;
  project: string;
  status: string;
  extra?: string;
}): string {
  return `---
id: ${opts.id}
slug: ${opts.slug}
title: ${opts.slug}
project: ${opts.project}
template: legacy
status: ${opts.status}
priority: medium
created: "2026-01-01T00:00:00Z"
updated: "2026-01-02T00:00:00Z"
depends_on: []
links: []
tags: []
blocked: null
parked: null
workspace:
  repository: null
  branch: null
  worktree: null
  parentBranch: null
plan:
  file: null
  approvedDigest: null
  approvedAt: null
  approvedBy: null
${opts.extra ?? ''}
---
## Objective

Test.
`;
}

async function buildStatusesFixture(root: string): Promise<void> {
  const projectDir = resolve(root, 'projects', 'demo');
  await mkdir(resolve(projectDir, 'tickets'), { recursive: true });
  await writeFile(
    resolve(projectDir, 'project.md'),
    renderProject({
      id: 'demo-id',
      slug: 'demo',
      title: 'Demo',
      timestamp: '2026-01-01T00:00:00Z',
      prefix: 'DEM',
      nextTicket: 20,
    }),
  );
  await writeFile(
    resolve(root, 'config.md'),
    renderConfig({ defaultProjectDir: resolve(root, 'projects') }),
  );
  await seedMissingBuiltins(root);

  const tickets: Array<{ folder: string; body: string }> = [
    {
      folder: 'DEM-1-draft',
      body: v2StatusTicketMd({
        id: 'DEM-1',
        slug: 'draft-ticket',
        project: 'demo',
        status: 'draft',
        extra: `statusHistory:
  - at: "2026-01-01T00:00:00Z"
    from: null
    to: draft
    command: create
    by: null
`,
      }),
    },
    {
      folder: 'DEM-2-planning',
      body: v2StatusTicketMd({
        id: 'DEM-2',
        slug: 'planning-ticket',
        project: 'demo',
        status: 'ready_for_planning',
      }),
    },
    {
      folder: 'DEM-3-ready',
      body: v2StatusTicketMd({
        id: 'DEM-3',
        slug: 'ready-ticket',
        project: 'demo',
        status: 'ready_to_implement',
      }),
    },
    {
      folder: 'DEM-4-blocked',
      body: v2StatusTicketMd({
        id: 'DEM-4',
        slug: 'blocked-ticket',
        project: 'demo',
        status: 'blocked',
        extra: 'blockedReason: "waiting on API"\n',
      }),
    },
    {
      folder: 'DEM-5-done',
      body: v2StatusTicketMd({
        id: 'DEM-5',
        slug: 'done-ticket',
        project: 'demo',
        status: 'completed',
      }),
    },
    {
      folder: 'DEM-6-dropped',
      body: v2StatusTicketMd({
        id: 'DEM-6',
        slug: 'dropped-ticket',
        project: 'demo',
        status: 'failed',
      }),
    },
    {
      folder: 'DEM-7-archived',
      body: v2StatusTicketMd({
        id: 'DEM-7',
        slug: 'archived-ticket',
        project: 'demo',
        status: 'in_progress',
        extra: 'archived: true\nphase: in_progress\ndisposition: active\n',
      }),
    },
    {
      folder: 'DEM-8-parked',
      body: `---
id: DEM-8
slug: parked-ticket
title: parked-ticket
project: demo
template: legacy
status: review
priority: medium
created: "2026-01-01T00:00:00Z"
updated: "2026-01-02T00:00:00Z"
depends_on: []
links: []
tags: []
blocked: null
parked: true
workspace:
  repository: null
  branch: null
  worktree: null
  parentBranch: null
plan:
  file: null
  approvedDigest: null
  approvedAt: null
  approvedBy: null
---
## Objective

Test.
`,
    },
    {
      folder: 'DEM-9-worktree',
      body: `---
id: DEM-9
slug: worktree-ticket
title: worktree-ticket
project: demo
template: legacy
status: in_progress
priority: medium
created: "2026-01-01T00:00:00Z"
updated: "2026-01-02T00:00:00Z"
depends_on: []
links: []
tags: []
blocked: null
parked: null
workspace:
  repository: /tmp/repo
  worktreePath: /tmp/wt
  branch: feat
  parentBranch: main
plan:
  file: null
  approvedDigest: null
  approvedAt: null
  approvedBy: null
---
## Objective

Test.
`,
    },
  ];

  for (const t of tickets) {
    const dir = resolve(projectDir, 'tickets', t.folder);
    await mkdir(dir, { recursive: true });
    await writeFile(resolve(dir, 'ticket.md'), t.body);
  }

  await mkdir(resolve(root, 'workflows'), { recursive: true });
  await writeFile(resolve(root, 'workflows', 'default.md'), '# workflow\n');
  await writeFile(resolve(root, 'derive-migrated'), '2026-01-01T00:00:00.000Z\n');
  await writeFile(resolve(root, 'stages-migrated'), '2026-01-01T00:00:00.000Z\n');

  const db = new Database(resolve(root, 'syntaur.db'));
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
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
    INSERT INTO meta (key, value) VALUES ('events_schema_version', '2');
  `);
  db.prepare(
    `INSERT INTO events (event_id, ticket_id, at, actor, type, details, source_key)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    'evt-sc',
    'DEM-2',
    '2026-01-02T00:00:00Z',
    'human',
    'status-change',
    JSON.stringify({ from: 'draft', to: 'ready_for_planning', command: 'derive' }),
    'live-status-1',
  );
  db.prepare(
    `INSERT INTO events (event_id, ticket_id, at, actor, type, details, source_key)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    'evt-pa',
    'DEM-3',
    '2026-01-02T00:00:00Z',
    'human',
    'plan-approval',
    JSON.stringify({ file: 'plan.md', digest: 'abc' }),
    'live-plan-1',
  );
  db.close();
}

describe('migrate v2 statuses step', () => {
  let stHome: string;
  let stConfigBefore: string;

  beforeEach(async () => {
    stHome = await mkdtemp(join(tmpdir(), 'syntaur-migrate-statuses-'));
    process.env.SYNTAUR_HOME = stHome;
    resetEventsDb();
    await buildStatusesFixture(stHome);
    stConfigBefore = await readFile(resolve(stHome, 'config.md'), 'utf-8');
    await writeFile(
      resolve(stHome, V2_MIGRATED_MARKER),
      'rename-ids 2026-09-12T12:46:05.342Z\ntemplates 2026-09-12T12:47:00.000Z\n',
    );
  });

  afterEach(async () => {
    closeEventsDb();
    resetEventsDb();
    await rm(stHome, { recursive: true, force: true });
  });

  it('runs statuses only when rename-ids and templates are complete', async () => {
    const hashBefore = await hashTree(stHome);
    const { lines } = await migrateV2Command({ root: stHome, apply: true });
    expect(lines.some((l) => l.startsWith('[apply] statuses:'))).toBe(true);
    expect(lines.some((l) => l.includes('project p1: prefix'))).toBe(false);
    const marker = await readFile(resolve(stHome, V2_MIGRATED_MARKER), 'utf-8');
    expect(marker).toContain('statuses ');
    expect(pendingMigrationSteps(await readMarkerSteps(resolve(stHome, V2_MIGRATED_MARKER)))).toEqual(
      [],
    );
    expect(await readFile(resolve(stHome, 'config.md'), 'utf-8')).toBe(stConfigBefore);
    expect(await hashTree(stHome)).not.toBe(hashBefore);
  });

  it('dry-run leaves files byte-identical and prints counts', async () => {
    const hashBefore = await hashTree(stHome);
    const { lines } = await migrateV2Command({ root: stHome, apply: false });
    expect(await hashTree(stHome)).toBe(hashBefore);
    expect(lines.some((l) => l.includes('statuses: 9 tickets mapped'))).toBe(true);
    expect(lines.some((l) => l.includes('archived → dropped: 1'))).toBe(true);
    expect(lines.some((l) => l.includes('flags: blocked 1, parked 1'))).toBe(true);
  });

  it('maps every legacy status, flags, worktree and drops engine fields', async () => {
    await migrateV2Command({ root: stHome, apply: true });
    const expectStatus = async (folder: string, status: string) => {
      const md = await readFile(
        resolve(stHome, 'projects', 'demo', 'tickets', folder, 'ticket.md'),
        'utf-8',
      );
      expect(md).toContain(`status: ${status}`);
      expect(md).not.toContain('statusHistory:');
      expect(md).not.toContain('blockedReason:');
      expect(md).not.toContain('worktreePath:');
      expect(md).not.toContain('phase:');
      expect(md).not.toContain('archived:');
      const fm = md.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? '';
      expect(listTopLevelFrontmatterKeys(fm)).toEqual([...V2_TICKET_FIELD_ORDER]);
      parseTicketFrontmatter(md);
      parseTicketFull(md);
    };
    await expectStatus('DEM-1-draft', 'backlog');
    await expectStatus('DEM-2-planning', 'planning');
    await expectStatus('DEM-3-ready', 'ready');
    await expectStatus('DEM-4-blocked', 'in_progress');
    await expectStatus('DEM-5-done', 'done');
    await expectStatus('DEM-6-dropped', 'dropped');
    await expectStatus('DEM-7-archived', 'dropped');
    await expectStatus('DEM-8-parked', 'review');
    await expectStatus('DEM-9-worktree', 'in_progress');

    const blockedMd = await readFile(
      resolve(stHome, 'projects', 'demo', 'tickets', 'DEM-4-blocked', 'ticket.md'),
      'utf-8',
    );
    expect(blockedMd).toContain('blocked: "waiting on API"');

    const parkedMd = await readFile(
      resolve(stHome, 'projects', 'demo', 'tickets', 'DEM-8-parked', 'ticket.md'),
      'utf-8',
    );
    expect(parkedMd).toContain('parked: "parked before v2 (no reason recorded)"');

    const wtMd = await readFile(
      resolve(stHome, 'projects', 'demo', 'tickets', 'DEM-9-worktree', 'ticket.md'),
      'utf-8',
    );
    expect(wtMd).toContain('worktree: /tmp/wt');
  });

  it('rewrites events, backfills history idempotently and removes markers', async () => {
    const draftFm = await readFile(
      resolve(stHome, 'projects', 'demo', 'tickets', 'DEM-1-draft', 'ticket.md'),
      'utf-8',
    );
    expect(draftFm).toContain('statusHistory:');
    await migrateV2Command({ root: stHome, apply: true });
    const db = new Database(resolve(stHome, 'syntaur.db'), { readonly: true });
    const moved = db
      .prepare(`SELECT details, source_key FROM events WHERE event_id = 'evt-sc'`)
      .get() as { details: string; source_key: string };
    expect(moved.source_key).toBe('live-status-1');
    expect(JSON.parse(moved.details)).toEqual({
      from: 'backlog',
      to: 'planning',
      verb: 'derive',
      by: 'human',
    });
    const planApproved = db
      .prepare(`SELECT type, source_key FROM events WHERE event_id = 'evt-pa'`)
      .get() as { type: string; source_key: string };
    expect(planApproved.type).toBe('plan-approved');
    expect(planApproved.source_key).toBe('live-plan-1');
    const allEvents = db
      .prepare(`SELECT event_id, type, source_key FROM events ORDER BY event_id`)
      .all() as Array<{ event_id: string; type: string; source_key: string | null }>;
    expect(allEvents.some((e) => e.source_key === 'backfill~DEM-1~status~0')).toBe(true);
    const backfill = allEvents.find((e) => e.source_key === 'backfill~DEM-1~status~0')!;
    expect(backfill.type).toBe('moved');
    const archived = db
      .prepare(`SELECT details FROM events WHERE source_key = ?`)
      .get('migrate~DEM-7~archived') as { details: string };
    expect(JSON.parse(archived.details).reason).toBe('archived');
    const backfillCountFirst = (
      db
        .prepare(`SELECT count(*) AS n FROM events WHERE source_key LIKE 'backfill~DEM-1~status~%'`)
        .get() as { n: number }
    ).n;
    db.close();
    closeEventsDb();
    resetEventsDb();

    expect(await fileExists(resolve(stHome, 'derive-migrated'))).toBe(false);
    expect(await fileExists(resolve(stHome, 'stages-migrated'))).toBe(false);
    expect(await fileExists(resolve(stHome, 'workflows'))).toBe(false);

    await expect(migrateV2Command({ root: stHome, apply: true })).rejects.toThrow(
      /already completed/,
    );

    await writeFile(
      resolve(stHome, V2_MIGRATED_MARKER),
      'rename-ids 2026-09-12T12:46:05.342Z\ntemplates 2026-09-12T12:47:00.000Z\n',
    );
    await migrateV2Command({ root: stHome, apply: true });
    const countDb = new Database(resolve(stHome, 'syntaur.db'), { readonly: true });
    const backfillCountSecond = (
      countDb
        .prepare(`SELECT count(*) AS n FROM events WHERE source_key LIKE 'backfill~DEM-1~status~%'`)
        .get() as { n: number }
    ).n;
    countDb.close();
    closeEventsDb();
    resetEventsDb();
    expect(backfillCountSecond).toBe(backfillCountFirst);
  });

  it('migrated tickets parse for show and pass doctor ticket checks', async () => {
    await migrateV2Command({ root: stHome, apply: true });
    const ticketDir = resolve(stHome, 'projects', 'demo', 'tickets', 'DEM-2-planning');
    const show = await buildShow(stHome, ticketDir);
    expect(show.ticket.id).toBe('DEM-2');
    expect(show.stage.id).toBe('planning');

    const ctx = await buildCheckContext(stHome);
    const dem2Dir = ticketDir;
    for (const check of ticketChecks) {
      const result = await check.run(ctx);
      const results = Array.isArray(result) ? result : [result];
      for (const r of results) {
        const touchesDem2 =
          r.affected?.some((p) => p.startsWith(dem2Dir)) ||
          (r.detail?.includes('DEM-2') ?? false);
        if (touchesDem2) {
          expect(r.status).not.toBe('error');
        }
      }
    }
    await closeCheckContext(ctx);
  });
});

describe('migrateV2Command duplicate slugs', () => {
  let dupHome: string;

  beforeEach(async () => {
    dupHome = await mkdtemp(join(tmpdir(), 'syntaur-migrate-dup-slug-'));
    process.env.SYNTAUR_HOME = dupHome;
    resetSessionDb();
    resetEventsDb();
    resetUsageDb();
    await buildDuplicateSlugFixture(dupHome);
  });

  afterEach(async () => {
    closeSessionDb();
    closeEventsDb();
    closeUsageDb();
    resetSessionDb();
    resetEventsDb();
    resetUsageDb();
    await rm(dupHome, { recursive: true, force: true });
  });

  it('scopes slug re-key by project and never collapses duplicate standalone slugs', async () => {
    const maps = {
      uuidToId: new Map([
        [UUID_DUP_SA1, 'SCR-1'],
        [UUID_DUP_SA2, 'SCR-2'],
        [UUID_DUP_P1S, 'P1-1'],
        [UUID_DUP_P2S, 'P2-1'],
      ]),
      slugToId: new Map([
        ['p1:shared', 'P1-1'],
        ['p2:shared', 'P2-1'],
        ['scratch:test', 'SCR-2'],
      ]),
      projectSlugToId: new Map([
        ['p1', new Map([['shared', 'P1-1']])],
        ['p2', new Map([['shared', 'P2-1']])],
        ['scratch', new Map<string, string>()],
      ]),
      itemIdMap: new Map<string, string>(),
      duplicateStandaloneSlugs: new Set(['test']),
      refWarnings: [] as string[],
    };
    const counts = rekeyDatabase(resolve(dupHome, 'syntaur.db'), maps);
    expect(counts.skippedStandaloneSlugRekeys).toEqual(['test']);

    const dbPath = resolve(dupHome, 'syntaur.db');
    const sessionDb = new Database(dbPath, { readonly: true });
    const usageDb = new Database(dbPath, { readonly: true });

    const engagementExpected: Record<string, string> = {
      'sess-sa1-uuid': 'SCR-1',
      'sess-sa2-uuid': 'SCR-2',
      'sess-sa1-slug': '',
      'sess-sa2-slug': '',
      'sess-p1-shared-uuid': 'P1-1',
      'sess-p2-shared-uuid': 'P2-1',
      'sess-p1-shared-slug': 'P1-1',
      'sess-p2-shared-slug': 'P2-1',
    };
    for (const [sessionId, expected] of Object.entries(engagementExpected)) {
      const row = sessionDb
        .prepare('SELECT assignment_id FROM engagement WHERE session_id = ?')
        .get(sessionId) as { assignment_id: string | null };
      expect(row.assignment_id ?? '').toBe(expected);
    }

    const usageExpected: Record<string, string> = {
      'ue-sa1-uuid': 'SCR-1',
      'ue-sa2-uuid': 'SCR-2',
      'ue-sa1-slug': 'test',
      'ue-sa2-slug': 'test',
      'ue-p1-shared-uuid': 'P1-1',
      'ue-p2-shared-uuid': 'P2-1',
      'ue-p1-shared-slug': 'P1-1',
      'ue-p2-shared-slug': 'P2-1',
    };
    for (const [sessionId, expected] of Object.entries(usageExpected)) {
      const row = usageDb
        .prepare('SELECT assignment_slug FROM usage_events WHERE session_id = ?')
        .get(sessionId) as { assignment_slug: string };
      expect(row.assignment_slug).toBe(expected);
    }

    const dailyRows = usageDb
      .prepare('SELECT day, tool, assignment_slug FROM usage_daily ORDER BY day')
      .all() as Array<{ day: string; tool: string; assignment_slug: string }>;
    const dailyByDay = new Map(dailyRows.map((r) => [r.day, r.assignment_slug]));
    expect(dailyByDay.get('2026-01-01')).toBe('SCR-1');
    expect(dailyByDay.get('2026-01-02')).toBe('SCR-2');
    expect(dailyByDay.get('2026-01-03')).toBe('test');
    expect(dailyByDay.get('2026-01-04')).toBe('test');
    expect(dailyByDay.get('2026-01-05')).toBe('P1-1');
    expect(dailyByDay.get('2026-01-06')).toBe('P2-1');
    expect(dailyByDay.get('2026-01-07')).toBe('P1-1');
    expect(dailyByDay.get('2026-01-08')).toBe('P2-1');

    sessionDb.close();
    usageDb.close();
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
