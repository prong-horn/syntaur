import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { computeInbox, type InboxStatusConfig } from '../inbox/index.js';
import type { InboxCategory } from '../inbox/types.js';
import { buildDefaultStatusConfig } from '../utils/config.js';
import { buildTransitionTable } from '../lifecycle/state-machine.js';
import { planDigest } from '../lifecycle/facts.js';
import { formatCommentEntry, type Comment } from '../templates/index.js';

let root: string;
let projectsDir: string;
let standaloneDir: string;

const NOW = Date.parse('2026-06-16T12:00:00Z');

function statusConfig(): InboxStatusConfig {
  const def = buildDefaultStatusConfig();
  return {
    statuses: def.statuses,
    transitions: def.transitions,
    transitionTable: buildTransitionTable(def.transitions),
    terminalStatuses: new Set(def.statuses.filter((s) => s.terminal).map((s) => s.id)),
  };
}

interface SeedOpts {
  id: string;
  slug: string;
  title?: string;
  status: string;
  project?: string | null; // null/undefined → standalone
  archived?: boolean;
  blockedReason?: string;
  reviewRequested?: boolean;
  planApproval?: { file: string; digest: string };
  statusHistory?: string[]; // raw YAML lines under statusHistory:
  updated?: string;
  created?: string;
  extraFrontmatter?: string[];
  planFiles?: Record<string, string>; // filename → content
  comments?: Comment[];
}

/** Create a real on-disk assignment fixture (assignment.md + optional plan/comments). */
async function seed(o: SeedOpts): Promise<string> {
  const standalone = o.project === undefined || o.project === null;
  const dir = standalone
    ? join(standaloneDir, o.slug)
    : join(projectsDir, o.project as string, 'assignments', o.slug);
  await mkdir(dir, { recursive: true });

  const fm: string[] = [
    `id: ${o.id}`,
    `slug: ${o.slug}`,
    `title: ${o.title ?? o.slug}`,
    `status: ${o.status}`,
    `project: ${standalone ? 'null' : o.project}`,
  ];
  if (o.archived) fm.push('archived: true');
  if (o.blockedReason) fm.push(`blockedReason: ${o.blockedReason}`);
  if (o.reviewRequested) fm.push('reviewRequested: true');
  if (o.updated) fm.push(`updated: "${o.updated}"`);
  if (o.created) fm.push(`created: "${o.created}"`);
  if (o.planApproval) {
    fm.push('planApproval:');
    fm.push(`  file: ${o.planApproval.file}`);
    fm.push(`  digest: ${o.planApproval.digest}`);
    fm.push('  by: human');
    fm.push('  at: "2026-06-16T00:00:00Z"');
  }
  if (o.statusHistory) {
    fm.push('statusHistory:');
    fm.push(...o.statusHistory.map((l) => `  ${l}`));
  }
  if (o.extraFrontmatter) fm.push(...o.extraFrontmatter);

  await writeFile(join(dir, 'assignment.md'), `---\n${fm.join('\n')}\n---\n# ${o.title ?? o.slug}\n`);

  if (o.planFiles) {
    for (const [name, content] of Object.entries(o.planFiles)) {
      await writeFile(join(dir, name), content);
    }
  }
  if (o.comments && o.comments.length > 0) {
    const body = o.comments.map(formatCommentEntry).join('\n');
    await writeFile(
      join(dir, 'comments.md'),
      `---\nassignment: ${o.slug}\nentryCount: ${o.comments.length}\nupdated: "2026-06-16T00:00:00Z"\n---\n\n# Comments\n\n${body}\n`,
    );
  }
  return dir;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'syntaur-inbox-agg-'));
  projectsDir = join(root, 'projects');
  standaloneDir = join(root, 'standalone');
  await mkdir(projectsDir, { recursive: true });
  await mkdir(standaloneDir, { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function run(opts?: Partial<Parameters<typeof computeInbox>[0]>) {
  return computeInbox({
    projectsDir,
    assignmentsDir: standaloneDir,
    statusConfig: statusConfig(),
    now: NOW,
    ...opts,
  });
}

// ── empty inbox + JSON shape ───────────────────────────────────────────────────

describe('computeInbox — shape', () => {
  it('empty inbox returns the InboxResult JSON shape', async () => {
    const result = await run();
    expect(result).toEqual({
      items: [],
      counts: { review: 0, blocked: 0, question: 0, 'plan-approval': 0 },
      total: 0,
    });
  });

  it('every item carries the full field set', async () => {
    await seed({ id: 'u1', slug: 'rev', status: 'review', project: 'p1' });
    const result = await run();
    expect(result.items).toHaveLength(1);
    const item = result.items[0];
    expect(item).toMatchObject({
      project: 'p1',
      assignmentSlug: 'rev',
      assignmentId: 'u1',
      title: 'rev',
      category: 'review',
      since: expect.any(String),
      ageMs: expect.any(Number),
      summary: expect.any(String),
      action: { verb: 'Accept', command: 'syntaur complete rev --project p1' },
    });
    expect(Number.isNaN(Date.parse(item.since))).toBe(false);
  });

  it('review items expose the structured acceptCommand/reopenCommand fields', async () => {
    await seed({ id: 'u1', slug: 'rev', status: 'review', project: 'p1' });
    const result = await run();
    const item = result.items[0];
    expect(item.acceptCommand).toBe('complete');
    expect(item.reopenCommand).toBe('start');
    expect(item.commentId).toBeUndefined();
  });

  it('question items expose the structured commentId field', async () => {
    await seed({
      id: 'q',
      slug: 'qs',
      status: 'in_progress',
      project: 'p1',
      comments: [
        { id: 'c-open', timestamp: '2026-06-15T00:00:00Z', author: 'h', type: 'question', body: 'q?', resolved: false },
      ],
    });
    const result = await run();
    const q = result.items.find((i) => i.category === 'question')!;
    expect(q.commentId).toBe('c-open');
    expect(q.acceptCommand).toBeUndefined();
    expect(q.reopenCommand).toBeUndefined();
  });

  it('every emitted since is canonical RFC 3339 (no millis)', async () => {
    await seed({ id: 'u1', slug: 'rev', status: 'review', project: 'p1' });
    const result = await run();
    for (const item of result.items) {
      expect(item.since).not.toMatch(/\.\d{3}Z$/);
      expect(Number.isNaN(Date.parse(item.since))).toBe(false);
    }
  });
});

// ── positive categories ────────────────────────────────────────────────────────

describe('computeInbox — positive categories', () => {
  it('emits a review item', async () => {
    await seed({ id: 'r', slug: 'rev', status: 'review', project: 'p1' });
    const r = await run();
    expect(r.counts.review).toBe(1);
    expect(r.items[0].category).toBe('review');
  });

  it('emits a blocked item; blockedReason feeds summary not the predicate', async () => {
    await seed({ id: 'b', slug: 'blk', status: 'blocked', project: 'p1', blockedReason: 'waiting on api' });
    const r = await run();
    expect(r.counts.blocked).toBe(1);
    expect(r.items[0].summary).toContain('waiting on api');
    expect(r.items[0].action.command).toBe('syntaur unblock blk --project p1');
  });

  it('emits one item per unresolved question, skipping resolved/note/feedback', async () => {
    await seed({
      id: 'q',
      slug: 'qs',
      status: 'in_progress',
      project: 'p1',
      comments: [
        { id: 'c1', timestamp: '2026-06-15T00:00:00Z', author: 'h', type: 'question', body: 'open one', resolved: false },
        { id: 'c2', timestamp: '2026-06-15T00:00:00Z', author: 'h', type: 'question', body: 'resolved', resolved: true },
        { id: 'c3', timestamp: '2026-06-15T00:00:00Z', author: 'h', type: 'note', body: 'a note' },
        { id: 'c4', timestamp: '2026-06-15T00:00:00Z', author: 'h', type: 'feedback', body: 'fb' },
        { id: 'c5', timestamp: '2026-06-15T00:00:00Z', author: 'h', type: 'question', body: 'open two', resolved: false },
      ],
    });
    const r = await run();
    expect(r.counts.question).toBe(2);
    const cmds = r.items.filter((i) => i.category === 'question').map((i) => i.action.command);
    expect(cmds).toContain('syntaur comment qs "<answer>" --reply-to c1 --project p1');
    expect(cmds).toContain('syntaur comment qs "<answer>" --reply-to c5 --project p1');
  });

  it('emits a plan-approval item only with a latest unapproved plan', async () => {
    await seed({
      id: 'pa',
      slug: 'plan-it',
      status: 'ready_for_planning',
      project: 'p1',
      planFiles: { 'plan.md': '# plan\n' },
    });
    const r = await run();
    expect(r.counts['plan-approval']).toBe(1);
    expect(r.items[0].action.command).toBe('syntaur plan approve plan-it --project p1');
  });

  it('standalone item: omits --project and targets the UUID', async () => {
    await seed({ id: 'uuid-xyz', slug: 'uuid-xyz', status: 'review' });
    const r = await run();
    expect(r.items[0].project).toBeNull();
    expect(r.items[0].action.command).toBe('syntaur complete uuid-xyz');
  });
});

// ── excluded / negative cases ──────────────────────────────────────────────────

describe('computeInbox — exclusions', () => {
  it('skips archived assignments up front', async () => {
    await seed({ id: 'a', slug: 'arch', status: 'review', project: 'p1', archived: true });
    const r = await run();
    expect(r.total).toBe(0);
  });

  it('excludes draft / ready_to_implement / in_progress / terminal / parked', async () => {
    await seed({ id: '1', slug: 'd', status: 'draft', project: 'p1' });
    await seed({ id: '2', slug: 'rti', status: 'ready_to_implement', project: 'p1' });
    await seed({ id: '3', slug: 'ip', status: 'in_progress', project: 'p1' });
    await seed({ id: '4', slug: 'done', status: 'completed', project: 'p1' });
    await seed({ id: '5', slug: 'fail', status: 'failed', project: 'p1' });
    await seed({ id: '6', slug: 'park', status: 'parked', project: 'p1' });
    const r = await run();
    expect(r.total).toBe(0);
  });

  it('ready_for_planning WITHOUT a plan is excluded', async () => {
    await seed({ id: 'np', slug: 'noplan', status: 'ready_for_planning', project: 'p1' });
    const r = await run();
    expect(r.total).toBe(0);
  });

  it('ready_for_planning WITH an already-approved plan is excluded', async () => {
    const content = '# plan\n';
    await seed({
      id: 'ap',
      slug: 'approved',
      status: 'ready_for_planning',
      project: 'p1',
      planFiles: { 'plan.md': content },
      planApproval: { file: 'plan.md', digest: planDigest(content) },
    });
    const r = await run();
    expect(r.total).toBe(0);
  });

  it('a resolved-only comment set produces no question items', async () => {
    await seed({
      id: 'rq',
      slug: 'resolved-q',
      status: 'in_progress',
      project: 'p1',
      comments: [
        { id: 'c1', timestamp: '2026-06-15T00:00:00Z', author: 'h', type: 'question', body: 'done', resolved: true },
      ],
    });
    const r = await run();
    expect(r.counts.question).toBe(0);
    expect(r.total).toBe(0);
  });

  it('excludes a parked-disposition assignment even with status review', async () => {
    // Malformed pairing: disposition:parked but status:review. The up-front
    // disposition guard drops it (a parked item is not awaiting a decision).
    await seed({
      id: 'pk',
      slug: 'parked-rev',
      status: 'review',
      project: 'p1',
      extraFrontmatter: ['disposition: parked'],
    });
    const r = await run();
    expect(r.total).toBe(0);
  });

  it('excludes a parked-disposition assignment even with an open question', async () => {
    await seed({
      id: 'pkq',
      slug: 'parked-q',
      status: 'in_progress',
      project: 'p1',
      extraFrontmatter: ['disposition: parked'],
      comments: [
        { id: 'c1', timestamp: '2026-06-15T00:00:00Z', author: 'h', type: 'question', body: 'q?', resolved: false },
      ],
    });
    const r = await run();
    expect(r.counts.question).toBe(0);
    expect(r.total).toBe(0);
  });

  it('excludes a terminal-disposition assignment even with status review', async () => {
    await seed({
      id: 'tm',
      slug: 'terminal-rev',
      status: 'review',
      project: 'p1',
      extraFrontmatter: ['disposition: terminal'],
    });
    const r = await run();
    expect(r.total).toBe(0);
  });

  it('keeps a blocked-disposition assignment (only parked/terminal are dropped)', async () => {
    await seed({
      id: 'bd',
      slug: 'blocked-d',
      status: 'blocked',
      project: 'p1',
      extraFrontmatter: ['disposition: blocked'],
    });
    const r = await run();
    expect(r.counts.blocked).toBe(1);
  });
});

// ── since selection + ageMs + ordering ─────────────────────────────────────────

describe('computeInbox — since, age, ordering', () => {
  it('uses the to===review statusHistory entry for review since/ageMs', async () => {
    await seed({
      id: 'r',
      slug: 'rev',
      status: 'review',
      project: 'p1',
      statusHistory: [
        '- at: "2026-06-10T00:00:00Z"',
        '  to: in_progress',
        '  command: start',
        '- at: "2026-06-14T12:00:00Z"',
        '  to: review',
        '  command: review',
      ],
    });
    const r = await run();
    expect(r.items[0].since).toBe('2026-06-14T12:00:00Z');
    expect(r.items[0].ageMs).toBe(NOW - Date.parse('2026-06-14T12:00:00Z'));
  });

  it('orders most-urgent (largest ageMs) first within a category', async () => {
    await seed({
      id: 'old',
      slug: 'old',
      status: 'review',
      project: 'p1',
      statusHistory: ['- at: "2026-06-01T00:00:00Z"', '  to: review', '  command: review'],
    });
    await seed({
      id: 'new',
      slug: 'new',
      status: 'review',
      project: 'p1',
      statusHistory: ['- at: "2026-06-15T00:00:00Z"', '  to: review', '  command: review'],
    });
    await seed({
      id: 'mid',
      slug: 'mid',
      status: 'review',
      project: 'p1',
      statusHistory: ['- at: "2026-06-10T00:00:00Z"', '  to: review', '  command: review'],
    });
    const r = await run();
    expect(r.items.map((i) => i.assignmentSlug)).toEqual(['old', 'mid', 'new']);
  });
});

// ── filters: project / types / limit ───────────────────────────────────────────

describe('computeInbox — filters', () => {
  beforeEach(async () => {
    await seed({ id: 'r1', slug: 'r1', status: 'review', project: 'p1' });
    await seed({ id: 'b1', slug: 'b1', status: 'blocked', project: 'p1' });
    await seed({ id: 'r2', slug: 'r2', status: 'review', project: 'p2' });
    await seed({ id: 's1', slug: 's1', status: 'review' }); // standalone
  });

  it('project filter restricts to one project slug', async () => {
    const r = await run({ project: 'p1' });
    expect(r.total).toBe(2);
    expect(r.items.every((i) => i.project === 'p1')).toBe(true);
  });

  it('types filter restricts to a subset of categories', async () => {
    const r = await run({ types: ['blocked'] as InboxCategory[] });
    expect(r.total).toBe(1);
    expect(r.counts).toEqual({ review: 0, blocked: 1, question: 0, 'plan-approval': 0 });
    expect(r.items[0].category).toBe('blocked');
  });

  it('limit truncates items but counts/total reflect the FULL matched set', async () => {
    const r = await run({ limit: 2 });
    expect(r.total).toBe(4); // full
    expect(r.counts.review).toBe(3); // full (r1, r2, s1)
    expect(r.counts.blocked).toBe(1); // full
    expect(r.items).toHaveLength(2); // truncated
  });

  it('combined project + types filter', async () => {
    const r = await run({ project: 'p1', types: ['review'] as InboxCategory[] });
    expect(r.total).toBe(1);
    expect(r.items[0].assignmentSlug).toBe('r1');
  });
});

// ── board-parity sanity ────────────────────────────────────────────────────────

describe('computeInbox — board parity', () => {
  it('a blocked-status assignment becomes a blocked inbox item (progress[blocked] parity)', async () => {
    await seed({ id: 'b', slug: 'blk', status: 'blocked', project: 'p1' });
    const r = await run();
    expect(r.counts.blocked).toBe(1);
  });

  it('open-question count matches the unresolved-question parity filter', async () => {
    await seed({
      id: 'q',
      slug: 'qs',
      status: 'in_progress',
      project: 'p1',
      comments: [
        { id: 'a', timestamp: '2026-06-15T00:00:00Z', author: 'h', type: 'question', body: 'x', resolved: false },
        { id: 'b', timestamp: '2026-06-15T00:00:00Z', author: 'h', type: 'question', body: 'y', resolved: false },
        { id: 'c', timestamp: '2026-06-15T00:00:00Z', author: 'h', type: 'question', body: 'z', resolved: true },
      ],
    });
    const r = await run();
    expect(r.counts.question).toBe(2);
  });
});
