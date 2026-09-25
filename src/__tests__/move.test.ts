import { createHash } from 'node:crypto';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { runMove, applyMove, planMoveTicket, MoveRefusedError } from '../commands/move.js';
import { runShowCommand } from '../commands/show.js';
import { newCommand } from '../commands/new.js';
import { resolveTicketById } from '../utils/ticket-resolver.js';
import { isPlanApproved } from '../ticket-templates/plan-facts.js';
import { parseTicketFrontmatter } from '../lifecycle/frontmatter.js';
import { initSessionDb, getSessionDb, resetSessionDb, closeSessionDb } from '../dashboard/session-db.js';
import { initEventsDb, resetEventsDb, closeEventsDb } from '../db/events-db.js';
import { initUsageDb, resetUsageDb, closeUsageDb } from '../db/usage-db.js';
import { rewriteChatEventLineForTicket } from '../chat/ticket-event-rewrite.js';
import { openChatLog } from '../chat/store.js';
import { resolveTicketTarget } from '../utils/ticket-target.js';
import { flagTicket } from '../lifecycle/verbs.js';

let home: string;
let projectsDir: string;
let origHome: string | undefined;

async function fingerprintTree(root: string): Promise<string> {
  const hash = createHash('sha256');
  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const p = resolve(dir, e.name);
      if (e.name === 'syntaur.db' || e.name === 'syntaur.db-wal' || e.name === 'syntaur.db-shm') {
        continue;
      }
      if (e.isDirectory()) await walk(p);
      else {
        const content = await readFile(p);
        hash.update(p);
        hash.update(content);
      }
    }
  }
  await walk(root);
  return hash.digest('hex');
}

async function writeProject(slug: string, prefix: string, nextTicket: number, extra = ''): Promise<void> {
  const dir = resolve(projectsDir, slug);
  await mkdir(dir, { recursive: true });
  await writeFile(
    resolve(dir, 'project.md'),
    `---\nid: p-${slug}\nslug: ${slug}\ntitle: ${slug}\nprefix: ${prefix}\nnextTicket: ${nextTicket}\narchived: false\n---\n# ${slug}\n${extra}`,
    'utf-8',
  );
  await mkdir(resolve(dir, 'tickets'), { recursive: true });
}

async function seedTicket(
  project: string,
  id: string,
  slug: string,
  extras: Record<string, string> = {},
): Promise<string> {
  const dir = resolve(projectsDir, project, 'tickets', `${id}-${slug}`);
  await mkdir(resolve(dir, 'chat'), { recursive: true });
  const lines = [
    '---',
    `id: ${id}`,
    `slug: ${slug}`,
    `project: ${project}`,
    'title: Move me',
    'status: backlog',
    'template: feature',
    'created: "2026-01-01T00:00:00Z"',
    'updated: "2026-01-01T00:00:00Z"',
    'depends_on: []',
    'links: []',
    'workspace:',
    '  repository: null',
    '  worktree: null',
    '  branch: null',
    '  parentBranch: null',
    'plan:',
    '  file: plan.md',
    '  approvedDigest: null',
    '  approvedAt: null',
    '  approvedBy: null',
    ...Object.entries(extras).map(([k, v]) => `${k}: ${v}`),
    '---',
    '',
    '# Ticket',
    '',
  ];
  await writeFile(resolve(dir, 'ticket.md'), lines.join('\n'), 'utf-8');
  return dir;
}

async function seedDb(ticketId: string, project: string): Promise<void> {
  const dbPath = resolve(home, 'syntaur.db');
  resetSessionDb();
  resetEventsDb();
  resetUsageDb();
  initSessionDb(dbPath);
  initEventsDb(dbPath);
  initUsageDb(dbPath);
  const sessionDb = getSessionDb();
  sessionDb
    .prepare(
      `INSERT INTO chat_sessions (session_key, ticket_id, agent_id, harness, state, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(`${ticketId}~claude`, ticketId, 'claude', 'claude-code', 'stopped', '2026-01-01T00:00:00Z');
  sessionDb
    .prepare(
      `INSERT INTO chat_items (item_id, ticket_id, session_key, agent_id, type, ts, seq_first, seq_last, json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      `session~${ticketId}~t1`,
      ticketId,
      `${ticketId}~claude`,
      'claude',
      'note',
      '2026-01-01T00:00:00Z',
      1,
      1,
      JSON.stringify({ ticketId, itemId: `session~${ticketId}~t1` }),
    );
  const eventsDb = initEventsDb(dbPath);
  eventsDb
    .prepare(
      `INSERT INTO events (event_id, ticket_id, at, actor, type, source_key) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run('evt-1', ticketId, '2026-01-01T00:00:00Z', 'human', 'log', `migrate~${ticketId}~archived`);
  closeSessionDb();
  closeEventsDb();
  closeUsageDb();
  resetSessionDb();
  resetEventsDb();
  resetUsageDb();
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'syntaur-move-'));
  projectsDir = resolve(home, 'projects');
  await mkdir(projectsDir, { recursive: true });
  await writeFile(
    resolve(home, 'config.md'),
    `---\nversion: "2.0"\ndefaultProjectDir: ${projectsDir}\n---\n`,
    'utf-8',
  );
  origHome = process.env.SYNTAUR_HOME;
  process.env.SYNTAUR_HOME = home;
});

afterEach(async () => {
  closeSessionDb();
  closeEventsDb();
  closeUsageDb();
  resetSessionDb();
  resetEventsDb();
  resetUsageDb();
  if (origHome === undefined) delete process.env.SYNTAUR_HOME;
  else process.env.SYNTAUR_HOME = origHome;
  await rm(home, { recursive: true, force: true });
});

describe('syntaur move', () => {
  it('dry run changes nothing (content fingerprint)', async () => {
    await writeProject('src-proj', 'SP', 2);
    await writeProject('dst-proj', 'DP', 1);
    await seedTicket('src-proj', 'SP-1', 'alpha');
    const before = await fingerprintTree(home);
    await runMove({ ticket: 'SP-1', to: 'dst-proj', apply: false });
    expect(await fingerprintTree(home)).toBe(before);
  });

  it('single move end to end rewrites folder, frontmatter, chat, markers, snoozes, context, links, and DB', async () => {
    await writeProject('src-proj', 'SP', 3);
    await writeProject('dst-proj', 'DP', 1);
    const ticketDir = await seedTicket('src-proj', 'SP-1', 'alpha');
    const log = await openChatLog(ticketDir);
    await log.append({
      ticketId: 'SP-1',
      agentId: 'claude',
      sessionKey: 'SP-1~claude',
      turnId: null,
      kind: 'user.message',
      payload: { messageId: 'm1', text: 'hi' },
    });
    await writeFile(
      resolve(ticketDir, 'journal.md'),
      `<!-- syntaur-chat kind="reply" item="session~SP-1~t1" -->\n`,
      'utf-8',
    );
    await writeFile(
      resolve(ticketDir, 'comments.md'),
      `<!-- syntaur-chat kind="ask" item="session~SP-1~t1" -->\n`,
      'utf-8',
    );
    const wt = resolve(home, 'wt');
    await mkdir(resolve(wt, '.syntaur'), { recursive: true });
    await writeFile(
      resolve(wt, '.syntaur', 'context.json'),
      JSON.stringify({ ticketId: 'SP-1', ticketDir }),
      'utf-8',
    );
    await writeFile(
      resolve(home, 'inbox-snoozes.json'),
      JSON.stringify({ 'SP-1~review': { until: '2099-01-01T00:00:00Z' } }, null, 2),
      'utf-8',
    );
    const otherDir = await seedTicket('src-proj', 'SP-2', 'beta');
    let otherMd = await readFile(resolve(otherDir, 'ticket.md'), 'utf-8');
    otherMd = otherMd.replace('depends_on: []', 'depends_on:\n  - SP-1').replace(
      'links: []',
      'links:\n  - src-proj/alpha',
    );
    await writeFile(resolve(otherDir, 'ticket.md'), otherMd, 'utf-8');
    let mainMd = await readFile(resolve(ticketDir, 'ticket.md'), 'utf-8');
    mainMd = mainMd.replace('worktree: null', `worktree: ${wt}`);
    await writeFile(resolve(ticketDir, 'ticket.md'), mainMd, 'utf-8');
    await seedDb('SP-1', 'src-proj');

    const plan = await planMoveTicket(projectsDir, 'SP-1', 'dst-proj');
    await applyMove(plan, { syntaurHome: home, now: () => '2026-06-01T00:00:00Z' });

    const newDir = resolve(projectsDir, 'dst-proj', 'tickets', 'DP-1-alpha');
    await expect(stat(newDir)).resolves.toBeDefined();
    const ticketMd = await readFile(resolve(newDir, 'ticket.md'), 'utf-8');
    expect(ticketMd).toContain('id: DP-1');
    expect(ticketMd).toContain('project: dst-proj');
    expect(ticketMd).toContain('movedFrom:');
    expect(ticketMd).toContain('SP-1@src-proj');

    const eventLine = await readFile(resolve(newDir, 'chat', 'events.jsonl'), 'utf-8');
    expect(eventLine).toContain('DP-1');
    expect(eventLine).not.toContain('SP-1~');

    const journal = await readFile(resolve(newDir, 'journal.md'), 'utf-8');
    expect(journal).toContain('session~DP-1~t1');
    const comments = await readFile(resolve(newDir, 'comments.md'), 'utf-8');
    expect(comments).toContain('session~DP-1~t1');

    const snoozes = JSON.parse(await readFile(resolve(home, 'inbox-snoozes.json'), 'utf-8')) as Record<
      string,
      unknown
    >;
    expect(snoozes['DP-1~review']).toBeDefined();

    const ctx = JSON.parse(await readFile(resolve(wt, '.syntaur', 'context.json'), 'utf-8')) as {
      ticketId: string;
      ticketDir: string;
    };
    expect(ctx.ticketId).toBe('DP-1');
    expect(ctx.ticketDir).toBe(newDir);

    const otherAfter = await readFile(resolve(otherDir, 'ticket.md'), 'utf-8');
    expect(otherAfter).toContain('DP-1');
    expect(otherAfter).toContain('dst-proj/alpha');

    resetSessionDb();
    initSessionDb(resolve(home, 'syntaur.db'));
    const db = getSessionDb();
    expect(
      (db.prepare('SELECT ticket_id FROM chat_sessions WHERE session_key = ?').get('DP-1~claude') as {
        ticket_id: string;
      }).ticket_id,
    ).toBe('DP-1');
    expect(
      (db.prepare('SELECT COUNT(*) AS n FROM chat_items WHERE ticket_id = ?').get('SP-1') as { n: number }).n,
    ).toBe(0);
    const item = db
      .prepare('SELECT json FROM chat_items WHERE ticket_id = ?')
      .get('DP-1') as { json: string };
    expect(item.json).toContain('DP-1');
    closeSessionDb();
    resetSessionDb();

    const eventsDb = initEventsDb(resolve(home, 'syntaur.db'));
    expect(
      (eventsDb.prepare('SELECT source_key FROM events WHERE event_id = ?').get('evt-1') as {
        source_key: string;
      }).source_key,
    ).toBe('migrate~DP-1~archived');
    closeEventsDb();
    resetEventsDb();
  });

  it('syntaur show OLD resolves with Moved line', async () => {
    await writeProject('src-proj', 'SP', 2);
    await writeProject('dst-proj', 'DP', 1);
    const ticketDir = await seedTicket('src-proj', 'SP-1', 'alpha');
    const plan = await planMoveTicket(projectsDir, 'SP-1', 'dst-proj');
    await applyMove(plan, { syntaurHome: home, now: () => '2026-06-01T00:00:00Z' });
    const logs: string[] = [];
    const orig = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(' '));
    await runShowCommand('SP-1', { dir: home });
    console.log = orig;
    expect(logs[0]).toMatch(/Moved: SP-1 → DP-1 \(project dst-proj\)/);
    expect(logs.some((l) => l.includes('Move me') || l.length > 20)).toBe(true);
  });

  it('syntaur show OLD --project old resolves with Moved line', async () => {
    await writeProject('src-proj', 'SP', 2);
    await writeProject('dst-proj', 'DP', 1);
    await seedTicket('src-proj', 'SP-1', 'alpha');
    const plan = await planMoveTicket(projectsDir, 'SP-1', 'dst-proj');
    await applyMove(plan, { syntaurHome: home, now: () => '2026-06-01T00:00:00Z' });
    const logs: string[] = [];
    const orig = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(' '));
    await runShowCommand('SP-1', { project: 'src-proj', dir: home });
    console.log = orig;
    expect(logs[0]).toMatch(/Moved: SP-1 → DP-1/);
  });

  it('approved plan stays approved after move', async () => {
    await writeProject('src-proj', 'SP', 2);
    await writeProject('dst-proj', 'DP', 1);
    const ticketDir = await seedTicket('src-proj', 'SP-1', 'alpha');
    const planBody = '---\nticket: alpha\n---\n\n# Plan\n';
    await writeFile(resolve(ticketDir, 'plan.md'), planBody, 'utf-8');
    const digest = createHash('sha256').update(planBody, 'utf-8').digest('hex');
    let md = await readFile(resolve(ticketDir, 'ticket.md'), 'utf-8');
    md = md.replace('approvedDigest: null', `approvedDigest: ${digest}`);
    await writeFile(resolve(ticketDir, 'ticket.md'), md, 'utf-8');
    const plan = await planMoveTicket(projectsDir, 'SP-1', 'dst-proj');
    await applyMove(plan, { syntaurHome: home, now: () => '2026-06-01T00:00:00Z' });
    const newDir = resolve(projectsDir, 'dst-proj', 'tickets', 'DP-1-alpha');
    const fm = parseTicketFrontmatter(await readFile(resolve(newDir, 'ticket.md'), 'utf-8'));
    expect(await isPlanApproved(newDir, fm)).toBe(true);
  });

  it('new in source project after move gets a higher number than the moved ticket', async () => {
    await writeProject('src-proj', 'SP', 2);
    await writeProject('dst-proj', 'DP', 1);
    await seedTicket('src-proj', 'SP-1', 'alpha');
    const plan = await planMoveTicket(projectsDir, 'SP-1', 'dst-proj');
    await applyMove(plan, { syntaurHome: home, now: () => '2026-06-01T00:00:00Z' });
    const created = await newCommand('Next', { project: 'src-proj', dir: projectsDir, silent: true });
    expect(created.id).toBe('SP-2');
  });

  it('refuses missing destination project', async () => {
    await writeProject('src-proj', 'SP', 2);
    await seedTicket('src-proj', 'SP-1', 'alpha');
    await expect(runMove({ ticket: 'SP-1', to: 'missing', apply: false })).rejects.toThrow(/does not exist/);
  });

  it('refuses archived destination project', async () => {
    await writeProject('src-proj', 'SP', 2);
    await writeProject('dst-proj', 'DP', 1);
    const dstMd = await readFile(resolve(projectsDir, 'dst-proj', 'project.md'), 'utf-8');
    await writeFile(
      resolve(projectsDir, 'dst-proj', 'project.md'),
      dstMd.replace('archived: false', 'archived: true'),
      'utf-8',
    );
    await seedTicket('src-proj', 'SP-1', 'alpha');
    await expect(runMove({ ticket: 'SP-1', to: 'dst-proj', apply: false })).rejects.toThrow(/archived/);
  });

  it('refuses when destination equals source project', async () => {
    await writeProject('src-proj', 'SP', 2);
    await seedTicket('src-proj', 'SP-1', 'alpha');
    await expect(runMove({ ticket: 'SP-1', to: 'src-proj', apply: false })).rejects.toThrow(/already in project/);
  });

  it('refuses slug collision in destination', async () => {
    await writeProject('src-proj', 'SP', 2);
    await writeProject('dst-proj', 'DP', 2);
    await seedTicket('src-proj', 'SP-1', 'alpha');
    await seedTicket('dst-proj', 'DP-1', 'alpha');
    await expect(runMove({ ticket: 'SP-1', to: 'dst-proj', apply: false })).rejects.toThrow(/slug/);
  });

  for (const state of ['spawning', 'ready', 'running', 'idle'] as const) {
    it(`refuses move when chat session state is ${state}`, async () => {
      await writeProject('src-proj', 'SP', 2);
      await writeProject('dst-proj', 'DP', 1);
      await seedTicket('src-proj', 'SP-1', 'alpha');
      await seedDb('SP-1', 'src-proj');
      resetSessionDb();
      initSessionDb(resolve(home, 'syntaur.db'));
      getSessionDb()
        .prepare('UPDATE chat_sessions SET state = ? WHERE ticket_id = ?')
        .run(state, 'SP-1');
      closeSessionDb();
      resetSessionDb();
      await expect(runMove({ ticket: 'SP-1', to: 'dst-proj', apply: false })).rejects.toThrow(/chat session/);
    });
  }

  for (const state of ['none', 'stopped', 'error'] as const) {
    it(`allows dry-run when chat session state is ${state}`, async () => {
      await writeProject('src-proj', 'SP', 2);
      await writeProject('dst-proj', 'DP', 1);
      await seedTicket('src-proj', 'SP-1', 'alpha');
      await seedDb('SP-1', 'src-proj');
      resetSessionDb();
      initSessionDb(resolve(home, 'syntaur.db'));
      getSessionDb()
        .prepare('UPDATE chat_sessions SET state = ? WHERE ticket_id = ?')
        .run(state, 'SP-1');
      closeSessionDb();
      resetSessionDb();
      const { lines } = await runMove({ ticket: 'SP-1', to: 'dst-proj', apply: false });
      expect(lines[0]).toContain('[dry-run]');
    });
  }

  it('resolveTicketTarget with --project old resolves moved ticket', async () => {
    await writeProject('src-proj', 'SP', 2);
    await writeProject('dst-proj', 'DP', 1);
    await seedTicket('src-proj', 'SP-1', 'alpha');
    const plan = await planMoveTicket(projectsDir, 'SP-1', 'dst-proj');
    await applyMove(plan, { syntaurHome: home, now: () => '2026-06-01T00:00:00Z' });
    const r = await resolveTicketTarget('SP-1', { project: 'src-proj', dir: projectsDir });
    expect(r.id).toBe('DP-1');
  });

  it('resolveTicketTarget with wrong --project still errors', async () => {
    await writeProject('src-proj', 'SP', 2);
    await writeProject('dst-proj', 'DP', 1);
    await seedTicket('src-proj', 'SP-1', 'alpha');
    const plan = await planMoveTicket(projectsDir, 'SP-1', 'dst-proj');
    await applyMove(plan, { syntaurHome: home, now: () => '2026-06-01T00:00:00Z' });
    await expect(
      resolveTicketTarget('SP-1', { project: 'other-proj', dir: projectsDir }),
    ).rejects.toThrow(/not found/);
  });

  it('lifecycle block accepts OLD id with --project old', async () => {
    await writeProject('src-proj', 'SP', 2);
    await writeProject('dst-proj', 'DP', 1);
    await seedTicket('src-proj', 'SP-1', 'alpha');
    const plan = await planMoveTicket(projectsDir, 'SP-1', 'dst-proj');
    await applyMove(plan, { syntaurHome: home, now: () => '2026-06-01T00:00:00Z' });
    await flagTicket('SP-1', 'block', 'wait', { project: 'src-proj', dir: projectsDir });
    const md = await readFile(resolve(projectsDir, 'dst-proj', 'tickets', 'DP-1-alpha', 'ticket.md'), 'utf-8');
    expect(md).toContain('blocked:');
  });

  it('rewriteChatEventLineForTicket re-keys migrate source keys', () => {
    const line = `${JSON.stringify({ ticketId: 'SP-1', sessionKey: 'SP-1~a' })}\n`;
    const out = rewriteChatEventLineForTicket(line, 'SP-1', 'DP-1');
    expect(out).toContain('DP-1');
    expect(out).not.toContain('SP-1');
  });

  it('bulk move reports preview ids in numeric order', async () => {
    await writeProject('src-proj', 'SP', 4);
    await writeProject('dst-proj', 'DP', 1);
    await seedTicket('src-proj', 'SP-2', 'b');
    await seedTicket('src-proj', 'SP-10', 'ten');
    const { lines } = await runMove({ allFrom: 'src-proj', to: 'dst-proj', apply: false });
    expect(lines[0]).toContain('SP-2 → DP-1 (preview)');
    expect(lines[1]).toContain('SP-10 → DP-2 (preview)');
  });

  it('injected failure at db-rekey leaves ticket and DB unchanged', async () => {
    await writeProject('src-proj', 'SP', 2);
    await writeProject('dst-proj', 'DP', 1);
    await seedTicket('src-proj', 'SP-1', 'alpha');
    await seedDb('SP-1', 'src-proj');
    const dbBefore = await readFile(resolve(home, 'syntaur.db'));
    const plan = await planMoveTicket(projectsDir, 'SP-1', 'dst-proj');
    await expect(
      applyMove(plan, {
        syntaurHome: home,
        now: () => '2026-06-01T00:00:00Z',
        fail: (step) => {
          if (step === 'db-rekey') throw new Error('injected db');
        },
      }),
    ).rejects.toThrow('injected db');
    await expect(stat(resolve(projectsDir, 'src-proj', 'tickets', 'SP-1-alpha'))).resolves.toBeDefined();
    expect(await readFile(resolve(home, 'syntaur.db'))).toEqual(dbBefore);
  });

  it('injected failure at home-json leaves ticket fully unmoved and DB unchanged', async () => {
    await writeProject('src-proj', 'SP', 2);
    await writeProject('dst-proj', 'DP', 1);
    const ticketDir = await seedTicket('src-proj', 'SP-1', 'alpha');
    await writeFile(resolve(home, 'inbox-snoozes.json'), '{}\n', 'utf-8');
    await seedDb('SP-1', 'src-proj');
    const dbBefore = await readFile(resolve(home, 'syntaur.db'));
    const plan = await planMoveTicket(projectsDir, 'SP-1', 'dst-proj');
    await expect(
      applyMove(plan, {
        syntaurHome: home,
        now: () => '2026-06-01T00:00:00Z',
        fail: (step) => {
          if (step === 'home-json') throw new Error('injected home');
        },
      }),
    ).rejects.toThrow('injected home');
    await expect(stat(ticketDir)).resolves.toBeDefined();
    expect(await readFile(resolve(home, 'syntaur.db'))).toEqual(dbBefore);
    resetSessionDb();
    initSessionDb(resolve(home, 'syntaur.db'));
    const db = getSessionDb();
    expect(
      (db.prepare('SELECT ticket_id FROM chat_sessions WHERE ticket_id = ?').get('SP-1') as {
        ticket_id: string;
      }).ticket_id,
    ).toBe('SP-1');
    closeSessionDb();
    resetSessionDb();
  });

  it('moving twice accumulates movedFrom entries and both old ids resolve', async () => {
    await writeProject('p1', 'PI', 2);
    await writeProject('p2', 'PJ', 2);
    await writeProject('p3', 'PK', 1);
    await seedTicket('p1', 'PI-1', 'task');
    let plan = await planMoveTicket(projectsDir, 'PI-1', 'p2');
    await applyMove(plan, { syntaurHome: home, now: () => '2026-06-01T00:00:00Z' });
    plan = await planMoveTicket(projectsDir, 'PJ-2', 'p3');
    await applyMove(plan, { syntaurHome: home, now: () => '2026-06-02T00:00:00Z' });
    const md = await readFile(resolve(projectsDir, 'p3', 'tickets', 'PK-1-task', 'ticket.md'), 'utf-8');
    expect(md).toContain('PI-1@p1');
    expect(md).toContain('PJ-2@p2');
    expect((await resolveTicketById(projectsDir, 'PI-1'))?.id).toBe('PK-1');
    expect((await resolveTicketById(projectsDir, 'PJ-2'))?.id).toBe('PK-1');
  });
});
