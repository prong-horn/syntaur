import { createHash } from 'node:crypto';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { runMove, applyMove, planMoveTicket, MoveRefusedError } from '../commands/move.js';
import { runShowCommand } from '../commands/show.js';
import { newCommand } from '../commands/new.js';
import { resolveTicketById, parseMovedFrom as parseMovedFromResolver } from '../utils/ticket-resolver.js';
import { parseYamlBlockList } from '../utils/ticket-frontmatter-patch.js';
import { isPlanApproved } from '../ticket-templates/plan-facts.js';
import { parseTicketFrontmatter } from '../lifecycle/frontmatter.js';
import { initSessionDb, getSessionDb, resetSessionDb, closeSessionDb } from '../dashboard/session-db.js';
import { initEventsDb, resetEventsDb, closeEventsDb } from '../db/events-db.js';
import { initUsageDb, resetUsageDb, closeUsageDb } from '../db/usage-db.js';
import { rewriteChatEventLineForTicket } from '../chat/ticket-event-rewrite.js';
import { openChatLog, rebuildChatIndex } from '../chat/store.js';
import { resolveTicketTarget } from '../utils/ticket-target.js';
import { flagTicket } from '../lifecycle/verbs.js';

let home: string;
let projectsDir: string;
let origHome: string | undefined;

function snapshotChatTables(dbPath: string): string {
  resetSessionDb();
  initSessionDb(dbPath);
  const db = getSessionDb();
  const out = {
    chat_sessions: db.prepare('SELECT * FROM chat_sessions ORDER BY rowid').all(),
    chat_items: db.prepare('SELECT * FROM chat_items ORDER BY rowid').all(),
  };
  closeSessionDb();
  resetSessionDb();
  return JSON.stringify(out);
}

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

const GLUED_KEY_RE = /\S(assignee|tags|links|workspace|updated|movedFrom):/;

function realLayoutFrontmatter(
  id: string,
  project: string,
  slug: string,
  dependsOn: string,
): string {
  return [
    `id: ${id}`,
    `slug: ${slug}`,
    'title: "Agent runs: start and steer pi from the UI"',
    `project: ${project}`,
    'template: feature',
    'status: done',
    'priority: high',
    'blocked: null',
    'parked: null',
    'depends_on:',
    `  - ${dependsOn}`,
    'assignee: claude',
    'tags: []',
    'links: []',
    'workspace:',
    '  repository: /Users/brennen/job-applier-agent',
    '  branch: agent-runs',
    '  worktree: /Users/brennen/job-applier-agent/.worktrees/agent-runs',
    '  parentBranch: distribution-repo-split',
    'plan:',
    '  file: plan.md',
    '  approvedDigest: c3e03117ff2c205c70accb3f17b748533fac41e416ecdf1c72c2581812c7acd6',
    '  approvedAt: "2026-08-27T13:40:22Z"',
    '  approvedBy: human',
    'created: "2026-08-27T03:35:16Z"',
    'updated: "2026-09-25T13:40:42Z"',
  ].join('\n');
}

async function writeRealLayoutTicket(
  project: string,
  id: string,
  slug: string,
  dependsOn: string,
): Promise<string> {
  const dir = resolve(projectsDir, project, 'tickets', `${id}-${slug}`);
  await mkdir(dir, { recursive: true });
  const fm = realLayoutFrontmatter(id, project, slug, dependsOn);
  await writeFile(resolve(dir, 'ticket.md'), `---\n${fm}\n---\n\n# Ticket\n`, 'utf-8');
  return dir;
}

async function hashAllTicketMdFiles(): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const p = resolve(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.name === 'ticket.md') {
        const bytes = await readFile(p);
        out.set(p, createHash('sha256').update(bytes).digest('hex'));
      }
    }
  }
  await walk(projectsDir);
  return out;
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

  it('rewrites bare OLD ticket ids in other tickets links', async () => {
    await writeProject('src-proj', 'SP', 3);
    await writeProject('dst-proj', 'DP', 1);
    await seedTicket('src-proj', 'SP-1', 'alpha');
    const otherDir = await seedTicket('src-proj', 'SP-2', 'beta');
    let otherMd = await readFile(resolve(otherDir, 'ticket.md'), 'utf-8');
    otherMd = otherMd.replace('links: []', 'links:\n  - SP-1');
    await writeFile(resolve(otherDir, 'ticket.md'), otherMd, 'utf-8');
    const plan = await planMoveTicket(projectsDir, 'SP-1', 'dst-proj');
    await applyMove(plan, { syntaurHome: home, now: () => '2026-06-01T00:00:00Z' });
    const otherAfter = await readFile(resolve(otherDir, 'ticket.md'), 'utf-8');
    expect(otherAfter).toContain('DP-1');
    expect(otherAfter).not.toMatch(/links:\s*\n\s+- SP-1/m);
  });

  it('injected failure at home-json leaves ticket fully unmoved and DB unchanged', async () => {
    await writeProject('src-proj', 'SP', 2);
    await writeProject('dst-proj', 'DP', 1);
    const ticketDir = await seedTicket('src-proj', 'SP-1', 'alpha');
    await writeFile(resolve(home, 'inbox-snoozes.json'), '{}\n', 'utf-8');
    await seedDb('SP-1', 'src-proj');
    const log = await openChatLog(ticketDir);
    await log.append({
      ticketId: 'SP-1',
      agentId: 'claude',
      sessionKey: 'SP-1~claude',
      turnId: null,
      kind: 'user.message',
      payload: { messageId: 'm1', text: 'hi' },
      ts: '2026-01-01T00:00:00Z',
    });
    const dbPath = resolve(home, 'syntaur.db');
    resetSessionDb();
    initSessionDb(dbPath);
    await rebuildChatIndex(ticketDir, 'SP-1');
    closeSessionDb();
    resetSessionDb();
    const chatBefore = snapshotChatTables(dbPath);
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
    expect(snapshotChatTables(dbPath)).toBe(chatBefore);
  });

  it('injected failure at chat-rebuild restores chat_items and chat_sessions', async () => {
    await writeProject('src-proj', 'SP', 2);
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
      ts: '2026-01-01T00:00:00Z',
    });
    await seedDb('SP-1', 'src-proj');
    const dbPath = resolve(home, 'syntaur.db');
    resetSessionDb();
    initSessionDb(dbPath);
    await rebuildChatIndex(ticketDir, 'SP-1');
    closeSessionDb();
    resetSessionDb();
    const chatBefore = snapshotChatTables(dbPath);
    const plan = await planMoveTicket(projectsDir, 'SP-1', 'dst-proj');
    await expect(
      applyMove(plan, {
        syntaurHome: home,
        now: () => '2026-06-01T00:00:00Z',
        fail: (step) => {
          if (step === 'chat-rebuild') throw new Error('injected chat-rebuild');
        },
      }),
    ).rejects.toThrow('injected chat-rebuild');
    await expect(stat(ticketDir)).resolves.toBeDefined();
    expect(snapshotChatTables(dbPath)).toBe(chatBefore);
  });

  it('bulk apply stops with non-zero exit when a later ticket fails', async () => {
    await writeProject('src-proj', 'SP', 4);
    await writeProject('dst-proj', 'DP', 1);
    await seedTicket('src-proj', 'SP-1', 'one');
    await seedTicket('src-proj', 'SP-2', 'two');
    await seedTicket('src-proj', 'SP-3', 'three');
    let applyCount = 0;
    await expect(
      runMove({
        allFrom: 'src-proj',
        to: 'dst-proj',
        apply: true,
      }, {
        syntaurHome: home,
        now: () => '2026-06-01T00:00:00Z',
        fail: (step) => {
          if (step !== 'db-rekey') return;
          applyCount += 1;
          if (applyCount === 2) throw new Error('injected bulk stop');
        },
      }),
    ).rejects.toThrow('injected bulk stop');
    await expect(stat(resolve(projectsDir, 'dst-proj', 'tickets', 'DP-1-one'))).resolves.toBeDefined();
    await expect(stat(resolve(projectsDir, 'src-proj', 'tickets', 'SP-2-two'))).resolves.toBeDefined();
    await expect(stat(resolve(projectsDir, 'src-proj', 'tickets', 'SP-3-three'))).resolves.toBeDefined();
    const md2 = await readFile(resolve(projectsDir, 'src-proj', 'tickets', 'SP-2-two', 'ticket.md'), 'utf-8');
    expect(md2).toContain('id: SP-2');
    const md3 = await readFile(resolve(projectsDir, 'src-proj', 'tickets', 'SP-3-three', 'ticket.md'), 'utf-8');
    expect(md3).toContain('id: SP-3');
  });

  it('bulk apply failure report names moved and remaining ticket ids', async () => {
    await writeProject('src-proj', 'SP', 4);
    await writeProject('dst-proj', 'DP', 1);
    await seedTicket('src-proj', 'SP-1', 'one');
    await seedTicket('src-proj', 'SP-2', 'two');
    await seedTicket('src-proj', 'SP-3', 'three');
    let applyCount = 0;
    try {
      await runMove({
        allFrom: 'src-proj',
        to: 'dst-proj',
        apply: true,
      }, {
        syntaurHome: home,
        fail: (step) => {
          if (step !== 'db-rekey') return;
          applyCount += 1;
          if (applyCount === 2) throw new Error('injected bulk stop');
        },
      });
      expect.fail('expected rejection');
    } catch (err) {
      expect(err).toBeInstanceOf(MoveRefusedError);
      const lines = (err as MoveRefusedError).reportLines ?? [];
      const text = lines.join('\n');
      expect(text).toMatch(/Stopped after 1 ticket/);
      expect(text).toContain('SP-1 → DP-1');
      expect(text).toMatch(/Remaining: 2 ticket/);
    }
  });

  it('bulk up-front refusal lists failed tickets and changes nothing', async () => {
    await writeProject('src-proj', 'SP', 4);
    await writeProject('dst-proj', 'DP', 2);
    await seedTicket('src-proj', 'SP-1', 'ok');
    await seedTicket('src-proj', 'SP-2', 'collision');
    await seedTicket('src-proj', 'SP-3', 'busy');
    await seedTicket('dst-proj', 'DP-1', 'collision');
    await seedDb('SP-3', 'src-proj');
    resetSessionDb();
    initSessionDb(resolve(home, 'syntaur.db'));
    getSessionDb()
      .prepare('UPDATE chat_sessions SET state = ? WHERE ticket_id = ?')
      .run('running', 'SP-3');
    closeSessionDb();
    resetSessionDb();

    const before = await fingerprintTree(home);
    for (const apply of [false, true]) {
      try {
        await runMove({ allFrom: 'src-proj', to: 'dst-proj', apply });
        expect.fail('expected refusal');
      } catch (err) {
        expect(err).toBeInstanceOf(MoveRefusedError);
        const lines = (err as MoveRefusedError).reportLines ?? [];
        const text = lines.join('\n');
        expect(text).toContain('SP-2:');
        expect(text).toContain('SP-3:');
        expect(text).toMatch(/slug|chat session/i);
        expect(text).toContain(apply ? '[apply]' : '[dry-run]');
      }
    }
    expect(await fingerprintTree(home)).toBe(before);
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

  it('real-layout move updates one depends_on line and leaves unrelated tickets byte-identical', async () => {
    await writeProject('pi-jobs-ui', 'PJU', 13);
    await writeProject('dst-proj', 'DP', 1);
    await writeProject('other-a', 'OA', 1);
    await writeProject('other-b', 'OB', 1);
    await writeProject('other-c', 'OC', 1);

    const movedDir = await writeRealLayoutTicket('pi-jobs-ui', 'PJU-11', 'dep-target', 'PJU-10');
    const dependentDir = await writeRealLayoutTicket('pi-jobs-ui', 'PJU-12', 'agent-runs', 'PJU-11');
    const unrelatedDirs = [
      await writeRealLayoutTicket('other-a', 'OA-1', 'una', 'OA-9'),
      await writeRealLayoutTicket('other-b', 'OB-1', 'unb', 'OB-9'),
      await writeRealLayoutTicket('other-c', 'OC-1', 'unc', 'OC-9'),
    ];

    const beforeHashes = await hashAllTicketMdFiles();
    const dependentBefore = await readFile(resolve(dependentDir, 'ticket.md'), 'utf-8');

    const plan = await planMoveTicket(projectsDir, 'PJU-11', 'dst-proj');
    await applyMove(plan, { syntaurHome: home, now: () => '2026-09-26T00:00:00Z' });

    const dependentAfter = await readFile(resolve(dependentDir, 'ticket.md'), 'utf-8');
    expect(dependentAfter.replace('  - DP-1', '  - PJU-11')).toBe(dependentBefore);
    expect(dependentAfter).toContain('  - DP-1');
    expect(dependentAfter).not.toContain('PJU-11assignee');

    const afterHashes = await hashAllTicketMdFiles();
    for (const dir of unrelatedDirs) {
      const path = resolve(dir, 'ticket.md');
      expect(afterHashes.get(path)).toBe(beforeHashes.get(path));
    }

    const newDir = resolve(projectsDir, 'dst-proj', 'tickets', 'DP-1-dep-target');
    const movedMd = await readFile(resolve(newDir, 'ticket.md'), 'utf-8');
    expect(movedMd).not.toMatch(GLUED_KEY_RE);
    const fmBlock = movedMd.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? '';
    expect(parseYamlBlockList(fmBlock, 'movedFrom')).toEqual(['PJU-11@pi-jobs-ui']);
    expect(parseMovedFromResolver(fmBlock)).toEqual([{ id: 'PJU-11', project: 'pi-jobs-ui' }]);
    expect(fmBlock).toMatch(/^movedFrom:\n  - PJU-11@pi-jobs-ui$/m);
  });

  it('bulk chain move rewrites depends_on, keeps unrelated project byte-identical, show OLD resolves', async () => {
    await writeProject('chain-src', 'CS', 6);
    await writeProject('chain-dst', 'CD', 1);
    await writeProject('quiet-proj', 'QP', 2);

    const chainIds = ['CS-1', 'CS-2', 'CS-3', 'CS-4', 'CS-5'];
    const chainSlugs = ['t1', 't2', 't3', 't4', 't5'];
    for (let i = 0; i < chainIds.length; i++) {
      const dep = i === 0 ? 'CS-0' : chainIds[i - 1];
      await writeRealLayoutTicket('chain-src', chainIds[i], chainSlugs[i], dep);
    }
    const quietDir = await writeRealLayoutTicket('quiet-proj', 'QP-1', 'quiet', 'QP-9');
    const quietBefore = await readFile(resolve(quietDir, 'ticket.md'), 'utf-8');

    await runMove({ allFrom: 'chain-src', to: 'chain-dst', apply: true, dir: projectsDir }, {
      syntaurHome: home,
      now: () => '2026-09-26T00:00:00Z',
    });

    const quietAfter = await readFile(resolve(quietDir, 'ticket.md'), 'utf-8');
    expect(quietAfter).toBe(quietBefore);

    async function walkTicketMd(dir: string): Promise<string[]> {
      const paths: string[] = [];
      const entries = await readdir(dir, { withFileTypes: true });
      for (const e of entries) {
        const p = resolve(dir, e.name);
        if (e.isDirectory()) paths.push(...(await walkTicketMd(p)));
        else if (e.name === 'ticket.md') paths.push(p);
      }
      return paths;
    }

    for (const path of await walkTicketMd(projectsDir)) {
      const md = await readFile(path, 'utf-8');
      expect(md).not.toMatch(GLUED_KEY_RE);
    }

    for (let i = 0; i < chainIds.length; i++) {
      const newId = `CD-${i + 1}`;
      const dir = resolve(projectsDir, 'chain-dst', 'tickets', `${newId}-${chainSlugs[i]}`);
      const md = await readFile(resolve(dir, 'ticket.md'), 'utf-8');
      const fm = md.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? '';
      const seen = new Set<string>();
      for (const line of fm.split('\n')) {
        const m = line.match(/^([a-z_]+):/);
        if (!m) continue;
        if (
          ['repository', 'branch', 'worktree', 'parentBranch', 'file', 'approvedDigest', 'approvedAt', 'approvedBy'].includes(
            m[1],
          )
        ) {
          continue;
        }
        if (m[1] === 'workspace' || m[1] === 'plan') continue;
        expect(seen.has(m[1]), `duplicate top-level key ${m[1]} in ${newId}`).toBe(false);
        seen.add(m[1]);
      }
      if (i > 0) {
        expect(fm).toContain(`  - CD-${i}`);
        expect(fm).not.toContain(`  - ${chainIds[i - 1]}\n`);
      }
      const logs: string[] = [];
      const orig = console.log;
      console.log = (...args: unknown[]) => logs.push(args.join(' '));
      await runShowCommand(chainIds[i], { dir: home });
      console.log = orig;
      expect(logs[0]).toMatch(new RegExp(`Moved: ${chainIds[i]} → ${newId}`));
    }
  });
});
