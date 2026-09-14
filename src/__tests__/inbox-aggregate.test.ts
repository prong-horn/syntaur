import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  computeInbox,
  inboxRowKey,
  rowFingerprint,
  type InboxStatusConfig,
} from '../inbox/index.js';
import type { SnoozeMap } from '../inbox/types.js';
import type { InboxCategory } from '../inbox/types.js';
import { formatChatQuestionMarker } from '../chat/questions.js';
import type { ChatItem, PermissionRequestItem, QuestionItem } from '../chat/types.js';
import { planDigest } from '../ticket-templates/plan-facts.js';
import { formatCommentEntry, type Comment } from '../templates/index.js';

let root: string;
let projectsDir: string;

const NOW = Date.parse('2026-06-16T12:00:00Z');

function buildTransitionTable(
  transitions: Array<{ from: string; command: string; to: string }>,
): Map<string, string> {
  const table = new Map<string, string>();
  for (const t of transitions) {
    table.set(`${t.from}:${t.command}`, t.to);
  }
  return table;
}

function statusConfig(): InboxStatusConfig {
  const transitions = [
    { from: 'review', command: 'done', to: 'done' },
    { from: 'review', command: 'start', to: 'in_progress' },
  ];
  return {
    statuses: [
      { id: 'review' },
      { id: 'in_progress' },
      { id: 'done', terminal: true },
    ],
    transitions,
    transitionTable: buildTransitionTable(transitions),
    terminalStatuses: new Set(['done']),
    blockedParkedStatuses: new Set(['blocked', 'parked']),
  };
}

interface SeedOpts {
  id: string;
  slug: string;
  title?: string;
  status: string;
  project?: string;
  archived?: boolean;
  blockedReason?: string;
  reviewRequested?: boolean;
  plan?: { file: string; approvedDigest: string | null };
  statusHistory?: string[]; // raw YAML lines under statusHistory:
  updated?: string;
  created?: string;
  extraFrontmatter?: string[];
  planFiles?: Record<string, string>; // filename → content
  comments?: Comment[];
}

function toTicketId(id: string, slug: string): string {
  if (/^[A-Z]{2,5}-\d+$/.test(id)) return id;
  const letters = id.replace(/[^A-Za-z]/g, '').toUpperCase().padEnd(2, 'X').slice(0, 3);
  const num = (id.match(/\d+/) ?? slug.match(/\d+/) ?? ['1'])[0];
  return `${letters}-${num}`;
}

/** Create a real on-disk ticket fixture (ticket.md + optional plan/comments). */
async function seed(o: SeedOpts): Promise<string> {
  const project = o.project ?? 'p1';
  const ticketId = toTicketId(o.id, o.slug);
  const folder = `${ticketId}-${o.slug}`;
  const dir = join(projectsDir, project, 'tickets', folder);
  await mkdir(dir, { recursive: true });

  const fm: string[] = [
    `id: ${ticketId}`,
    `slug: ${o.slug}`,
    `title: ${o.title ?? o.slug}`,
    `status: ${o.status}`,
    `project: ${project}`,
  ];
  if (o.archived) fm.push('archived: true');
  if (o.blockedReason) fm.push(`blockedReason: ${o.blockedReason}`);
  if (o.reviewRequested) fm.push('reviewRequested: true');
  if (o.updated) fm.push(`updated: "${o.updated}"`);
  if (o.created) fm.push(`created: "${o.created}"`);
  const planMeta =
    o.plan ??
    (o.planFiles
      ? {
          file: Object.keys(o.planFiles)[0]!,
          approvedDigest: null,
        }
      : undefined);
  if (planMeta) {
    fm.push('plan:');
    fm.push(`  file: ${planMeta.file}`);
    fm.push(
      planMeta.approvedDigest === null
        ? '  approvedDigest: null'
        : `  approvedDigest: ${planMeta.approvedDigest}`,
    );
    fm.push('  approvedAt: null');
    fm.push('  approvedBy: null');
  }
  if (o.statusHistory) {
    fm.push('statusHistory:');
    fm.push(...o.statusHistory.map((l) => `  ${l}`));
  }
  if (o.extraFrontmatter) fm.push(...o.extraFrontmatter);

  await writeFile(join(dir, 'ticket.md'), `---\n${fm.join('\n')}\n---\n# ${o.title ?? o.slug}\n`);

  if (o.planFiles) {
    for (const [name, content] of Object.entries(o.planFiles)) {
      await writeFile(join(dir, name), content);
    }
  }
  if (o.comments && o.comments.length > 0) {
    const body = o.comments.map(formatCommentEntry).join('\n');
    await writeFile(
      join(dir, 'comments.md'),
      `---\nticket: ${o.slug}\nentryCount: ${o.comments.length}\nupdated: "2026-06-16T00:00:00Z"\n---\n\n# Comments\n\n${body}\n`,
    );
  }
  return dir;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'syntaur-inbox-agg-'));
  projectsDir = join(root, 'projects');
  await mkdir(projectsDir, { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function run(opts?: Partial<Parameters<typeof computeInbox>[0]>) {
  return computeInbox({
    projectsDir,
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
      counts: { question: 0, review: 0, 'plan-approval': 0 },
      total: 0,
      snoozedCount: 0,
      liftedSnoozeKeys: [],
    });
  });

  it('every item carries the full field set', async () => {
    await seed({ id: 'u1', slug: 'rev', status: 'review', project: 'p1' });
    const result = await run();
    expect(result.items).toHaveLength(1);
    const item = result.items[0];
    expect(item).toMatchObject({
      project: 'p1',
      ticketSlug: 'rev',
      ticketId: toTicketId('u1', 'rev'),
      title: 'rev',
      category: 'review',
      since: expect.any(String),
      ageMs: expect.any(Number),
      summary: expect.any(String),
      action: { verb: 'Accept', command: 'syntaur done rev --project p1' },
    });
    expect(Number.isNaN(Date.parse(item.since))).toBe(false);
  });

  it('review items expose the structured acceptCommand/reopenCommand fields', async () => {
    await seed({ id: 'u1', slug: 'rev', status: 'review', project: 'p1' });
    const result = await run();
    const item = result.items[0];
    expect(item.acceptCommand).toBe('done');
    expect(item.reopenCommand).toBe('reopen');
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

  it('does not emit a blocked ticket', async () => {
    await seed({ id: 'b', slug: 'blk', status: 'in_progress', project: 'p1', blockedReason: 'waiting on api' });
    const r = await run();
    expect(r.total).toBe(0);
    expect(r.counts).toEqual({ question: 0, review: 0, 'plan-approval': 0 });
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
      status: 'planning',
      project: 'p1',
      planFiles: { 'plan.md': '# plan\n' },
    });
    const r = await run();
    expect(r.counts['plan-approval']).toBe(1);
    expect(r.items[0].action.command).toBe('syntaur plan approve plan-it --project p1');
  });

  it('project item: targets ticket by id with --project', async () => {
    await seed({ id: 'IBX-1', slug: 'ibx', status: 'review', project: 'p1' });
    const r = await run({ project: 'p1' });
    expect(r.items[0].project).toBe('p1');
    expect(r.items[0].action.command).toBe('syntaur done ibx --project p1');
  });
});

// ── excluded / negative cases ──────────────────────────────────────────────────

describe('computeInbox — exclusions', () => {
  it('skips archived tickets up front', async () => {
    await seed({ id: 'a', slug: 'arch', status: 'review', project: 'p1', archived: true });
    const r = await run();
    expect(r.total).toBe(0);
  });

  it('excludes backlog / ready / in_progress / terminal / parked', async () => {
    await seed({ id: '1', slug: 'd', status: 'backlog', project: 'p1' });
    await seed({ id: '2', slug: 'rti', status: 'ready', project: 'p1' });
    await seed({ id: '3', slug: 'ip', status: 'in_progress', project: 'p1' });
    await seed({ id: '4', slug: 'done', status: 'done', project: 'p1' });
    await seed({ id: '5', slug: 'fail', status: 'dropped', project: 'p1' });
    await seed({ id: '6', slug: 'park', status: 'parked', project: 'p1' });
    const r = await run();
    expect(r.total).toBe(0);
  });

  it('planning WITHOUT a plan is excluded', async () => {
    await seed({ id: 'np', slug: 'noplan', status: 'planning', project: 'p1' });
    const r = await run();
    expect(r.total).toBe(0);
  });

  it('planning WITH an already-approved plan is excluded', async () => {
    const content = '# plan\n';
    await seed({
      id: 'ap',
      slug: 'approved',
      status: 'planning',
      project: 'p1',
      planFiles: { 'plan.md': content },
      plan: { file: 'plan.md', approvedDigest: planDigest(content) },
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

  it('excludes a parked-disposition ticket even with status review', async () => {
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

  it('excludes a parked-disposition ticket even with an open question', async () => {
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

  it('excludes a terminal-disposition ticket even with status review', async () => {
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

  it('excludes a TERMINAL-status ticket with NULL disposition and an open question', async () => {
    // Legacy/null-disposition: status is `done` (∈ terminalStatuses) with
    // no `disposition` field, plus an unresolved question. The terminal-STATUS
    // guard must drop it BEFORE the status-agnostic question loop — otherwise
    // the question would leak into the inbox.
    await seed({
      id: 'tnq',
      slug: 'terminal-null-q',
      status: 'done',
      project: 'p1',
      comments: [
        { id: 'c1', timestamp: '2026-06-15T00:00:00Z', author: 'h', type: 'question', body: 'q?', resolved: false },
      ],
    });
    const r = await run();
    expect(r.counts.question).toBe(0);
    expect(r.total).toBe(0);
  });

  it('keeps a blocked-flag ticket excluded (blocked category removed)', async () => {
    await seed({
      id: 'bd',
      slug: 'blocked-d',
      status: 'in_progress',
      project: 'p1',
      blockedReason: 'waiting',
    });
    const r = await run();
    expect(r.total).toBe(0);
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

  it('orders by tier first, then most-urgent (largest ageMs) within a tier', async () => {
    await seed({
      id: 'old',
      slug: 'old-rev',
      status: 'review',
      project: 'p1',
      statusHistory: ['- at: "2026-06-01T00:00:00Z"', '  to: review', '  command: review'],
    });
    await seed({
      id: 'new',
      slug: 'new-rev',
      status: 'review',
      project: 'p1',
      statusHistory: ['- at: "2026-06-15T00:00:00Z"', '  to: review', '  command: review'],
    });
    await seed({
      id: 'plan',
      slug: 'plan-row',
      status: 'planning',
      project: 'p1',
      planFiles: { 'plan.md': '# plan\n' },
      statusHistory: ['- at: "2026-06-10T00:00:00Z"', '  to: planning', '  command: shape'],
    });
    const r = await run();
    expect(r.items.map((i) => i.ticketSlug)).toEqual(['plan-row', 'old-rev', 'new-rev']);
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
    expect(r.items.map((i) => i.ticketSlug)).toEqual(['old', 'mid', 'new']);
  });
});

// ── tiered ordering with card lookup ───────────────────────────────────────────

function permissionItem(
  itemId: string,
  ticketId: string,
  extra?: Partial<PermissionRequestItem>,
): PermissionRequestItem {
  return {
    itemId,
    ticketId,
    turnId: 'turn-1',
    agentId: 'cursor',
    type: 'permission.request',
    ts: '2026-06-16T00:00:00Z',
    seqFirst: 1,
    seqLast: 1,
    sealed: false,
    requestId: `req-${itemId}`,
    toolCall: { title: 'Run uname' },
    options: [{ optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' }],
    ...extra,
  };
}

describe('computeInbox — tiered ordering with lookup', () => {
  it('pins an unsettled permission row above an older reply row', async () => {
    const permItemId = 'perm-new';
    const replyItemId = 'reply-old';
    const permMarker = formatChatQuestionMarker({ kind: 'permission', itemId: permItemId });
    const replyMarker = formatChatQuestionMarker({ kind: 'reply', itemId: replyItemId, turnId: 't1' });
    await seed({
      id: 'a-perm',
      slug: 'perm-row',
      status: 'in_progress',
      project: 'p1',
      comments: [
        {
          id: 'c-perm',
          timestamp: '2026-06-15T00:00:00Z',
          author: 'cursor',
          type: 'question',
          body: `Waiting for permission\n\n${permMarker}`,
          resolved: false,
        },
      ],
    });
    await seed({
      id: 'a-reply',
      slug: 'reply-row',
      status: 'in_progress',
      project: 'p1',
      comments: [
        {
          id: 'c-reply',
          timestamp: '2026-06-01T00:00:00Z',
          author: 'claude',
          type: 'question',
          body: `Need input\n\n${replyMarker}`,
          resolved: false,
        },
      ],
    });
    const lookup = new Map<string, ChatItem>([
      [permItemId, permissionItem(permItemId, 'a-perm')],
    ]);
    const r = await run({ lookupChatItem: (id) => lookup.get(id) ?? null });
    expect(r.items.map((i) => i.ticketSlug)).toEqual(['perm-row', 'reply-row']);
    expect(r.items[0].card?.settled).toBe(false);
  });

  it('demotes a settled permission card below an older reply row', async () => {
    const permItemId = 'perm-settled';
    const replyItemId = 'reply-older';
    const permMarker = formatChatQuestionMarker({ kind: 'permission', itemId: permItemId });
    const replyMarker = formatChatQuestionMarker({ kind: 'reply', itemId: replyItemId, turnId: 't1' });
    await seed({
      id: 'a-perm2',
      slug: 'perm-settled-row',
      status: 'in_progress',
      project: 'p1',
      comments: [
        {
          id: 'c-perm2',
          timestamp: '2026-06-15T00:00:00Z',
          author: 'cursor',
          type: 'question',
          body: `Waiting for permission\n\n${permMarker}`,
          resolved: false,
        },
      ],
    });
    await seed({
      id: 'a-reply2',
      slug: 'reply-older-row',
      status: 'in_progress',
      project: 'p1',
      comments: [
        {
          id: 'c-reply2',
          timestamp: '2026-06-01T00:00:00Z',
          author: 'claude',
          type: 'question',
          body: `Need input\n\n${replyMarker}`,
          resolved: false,
        },
      ],
    });
    const lookup = new Map<string, ChatItem>([
      [permItemId, permissionItem(permItemId, 'a-perm2', { answer: 'allow-once', sealed: true })],
    ]);
    const r = await run({ lookupChatItem: (id) => lookup.get(id) ?? null });
    expect(r.items.map((i) => i.ticketSlug)).toEqual(['reply-older-row', 'perm-settled-row']);
    expect(r.items[1].card?.settled).toBe(true);
  });

  it('orders five tiers correctly regardless of age', async () => {
    const permId = 'perm-tier';
    const replyId = 'reply-tier';
    const permMarker = formatChatQuestionMarker({ kind: 'permission', itemId: permId });
    const replyMarker = formatChatQuestionMarker({ kind: 'reply', itemId: replyId, turnId: 't1' });
    await seed({
      id: 't-card',
      slug: 'tier-card',
      status: 'in_progress',
      project: 'p1',
      comments: [
        {
          id: 'c-card',
          timestamp: '2026-06-14T00:00:00Z',
          author: 'cursor',
          type: 'question',
          body: `Permission\n\n${permMarker}`,
          resolved: false,
        },
      ],
    });
    await seed({
      id: 't-reply',
      slug: 'tier-reply',
      status: 'in_progress',
      project: 'p1',
      comments: [
        {
          id: 'c-reply-t',
          timestamp: '2026-06-13T00:00:00Z',
          author: 'claude',
          type: 'question',
          body: `Reply\n\n${replyMarker}`,
          resolved: false,
        },
      ],
    });
    await seed({
      id: 't-plain',
      slug: 'tier-plain',
      status: 'in_progress',
      project: 'p1',
      comments: [
        {
          id: 'c-plain',
          timestamp: '2026-06-12T00:00:00Z',
          author: 'human',
          type: 'question',
          body: 'Plain question?',
          resolved: false,
        },
      ],
    });
    await seed({
      id: 't-plan',
      slug: 'tier-plan',
      status: 'planning',
      project: 'p1',
      planFiles: { 'plan.md': '# plan\n' },
      statusHistory: ['- at: "2026-06-11T00:00:00Z"', '  to: planning', '  command: shape'],
    });
    await seed({
      id: 't-rev',
      slug: 'tier-rev',
      status: 'review',
      project: 'p1',
      statusHistory: ['- at: "2026-06-01T00:00:00Z"', '  to: review', '  command: review'],
    });
    const lookup = new Map<string, ChatItem>([[permId, permissionItem(permId, 't-card')]]);
    const r = await run({ lookupChatItem: (id) => lookup.get(id) ?? null });
    expect(r.items.map((i) => i.ticketSlug)).toEqual([
      'tier-card',
      'tier-reply',
      'tier-plain',
      'tier-plan',
      'tier-rev',
    ]);
  });

  it('orders two same-tier cards oldest-first', async () => {
    const permA = 'perm-a';
    const permB = 'perm-b';
    const markerA = formatChatQuestionMarker({ kind: 'permission', itemId: permA });
    const markerB = formatChatQuestionMarker({ kind: 'permission', itemId: permB });
    await seed({
      id: 'card-new',
      slug: 'card-newer',
      status: 'in_progress',
      project: 'p1',
      comments: [
        {
          id: 'c-new',
          timestamp: '2026-06-15T00:00:00Z',
          author: 'cursor',
          type: 'question',
          body: `Newer\n\n${markerA}`,
          resolved: false,
        },
      ],
    });
    await seed({
      id: 'card-old',
      slug: 'card-older',
      status: 'in_progress',
      project: 'p1',
      comments: [
        {
          id: 'c-old',
          timestamp: '2026-06-01T00:00:00Z',
          author: 'cursor',
          type: 'question',
          body: `Older\n\n${markerB}`,
          resolved: false,
        },
      ],
    });
    const lookup = new Map<string, ChatItem>([
      [permA, permissionItem(permA, 'card-new')],
      [permB, permissionItem(permB, 'card-old')],
    ]);
    const r = await run({ lookupChatItem: (id) => lookup.get(id) ?? null });
    expect(r.items.map((i) => i.ticketSlug)).toEqual(['card-older', 'card-newer']);
  });

  it('without lookup a permission row has no card key and is still tier 0', async () => {
    const permId = 'perm-no-lookup';
    const marker = formatChatQuestionMarker({ kind: 'permission', itemId: permId });
    await seed({
      id: 'a-nolookup',
      slug: 'no-lookup-row',
      status: 'in_progress',
      project: 'p1',
      comments: [
        {
          id: 'c-nolookup',
          timestamp: '2026-06-15T00:00:00Z',
          author: 'cursor',
          type: 'question',
          body: `Waiting\n\n${marker}`,
          resolved: false,
        },
      ],
    });
    await seed({
      id: 'a-rev-nl',
      slug: 'rev-nolookup',
      status: 'review',
      project: 'p1',
      statusHistory: ['- at: "2026-06-01T00:00:00Z"', '  to: review', '  command: review'],
    });
    const r = await run();
    expect(r.items[0].ticketSlug).toBe('no-lookup-row');
    expect(r.items[0]).not.toHaveProperty('card');
  });

  it('a lookup that throws yields card:null and tier 0', async () => {
    const permId = 'perm-throw';
    const marker = formatChatQuestionMarker({ kind: 'permission', itemId: permId });
    await seed({
      id: 'a-throw',
      slug: 'throw-row',
      status: 'in_progress',
      project: 'p1',
      comments: [
        {
          id: 'c-throw',
          timestamp: '2026-06-15T00:00:00Z',
          author: 'cursor',
          type: 'question',
          body: `Waiting\n\n${marker}`,
          resolved: false,
        },
      ],
    });
    const r = await run({
      lookupChatItem: () => {
        throw new Error('db closed');
      },
    });
    expect(r.items[0].ticketSlug).toBe('throw-row');
    expect(r.items[0].card).toBeNull();
  });

  it('limit:1 returns only the tier-0 row while counts/total cover all', async () => {
    const permId = 'perm-limit';
    const marker = formatChatQuestionMarker({ kind: 'permission', itemId: permId });
    await seed({
      id: 'a-limit-card',
      slug: 'limit-card',
      status: 'in_progress',
      project: 'p1',
      comments: [
        {
          id: 'c-limit',
          timestamp: '2026-06-15T00:00:00Z',
          author: 'cursor',
          type: 'question',
          body: `Waiting\n\n${marker}`,
          resolved: false,
        },
      ],
    });
    await seed({
      id: 'a-limit-rev',
      slug: 'limit-rev',
      status: 'review',
      project: 'p1',
      statusHistory: ['- at: "2026-06-01T00:00:00Z"', '  to: review', '  command: review'],
    });
    const lookup = new Map<string, ChatItem>([[permId, permissionItem(permId, 'a-limit-card')]]);
    const r = await run({ lookupChatItem: (id) => lookup.get(id) ?? null, limit: 1 });
    expect(r.items).toHaveLength(1);
    expect(r.items[0].ticketSlug).toBe('limit-card');
    expect(r.total).toBe(2);
    expect(r.counts).toEqual({ question: 1, review: 1, 'plan-approval': 0 });
  });
});

// ── filters: project / types / limit ───────────────────────────────────────────

describe('computeInbox — filters', () => {
  beforeEach(async () => {
    await seed({ id: 'r1', slug: 'r1', status: 'review', project: 'p1' });
    await seed({
      id: 'q1',
      slug: 'q1',
      status: 'in_progress',
      project: 'p1',
      comments: [
        { id: 'c1', timestamp: '2026-06-15T00:00:00Z', author: 'h', type: 'question', body: 'open?', resolved: false },
      ],
    });
    await seed({ id: 'r2', slug: 'r2', status: 'review', project: 'p2' });
    await seed({ id: 'R3-1', slug: 'r3', status: 'review', project: 'p1' });
  });

  it('project filter restricts to one project slug', async () => {
    const r = await run({ project: 'p1' });
    expect(r.total).toBe(3);
    expect(r.items.every((i) => i.project === 'p1')).toBe(true);
  });

  it('types filter restricts to a subset of categories', async () => {
    const r = await run({ types: ['question'] as InboxCategory[] });
    expect(r.total).toBe(1);
    expect(r.counts).toEqual({ question: 1, review: 0, 'plan-approval': 0 });
    expect(r.items[0].category).toBe('question');
  });

  it('limit truncates items but counts/total reflect the FULL matched set', async () => {
    const r = await run({ limit: 2 });
    expect(r.total).toBe(4); // full
    expect(r.counts.review).toBe(3); // full (r1, r2, s1)
    expect(r.counts.question).toBe(1); // full
    expect(r.items).toHaveLength(2); // truncated
  });

  it('combined project + types filter', async () => {
    const r = await run({ project: 'p1', types: ['review'] as InboxCategory[] });
    expect(r.total).toBe(2);
    expect(r.items.map((i) => i.ticketSlug).sort()).toEqual(['r1', 'r3']);
  });
});

// ── board-parity sanity ────────────────────────────────────────────────────────

describe('computeInbox — board parity', () => {
  it('blocked-flag tickets are excluded from the inbox queue', async () => {
    await seed({ id: 'b', slug: 'blk', status: 'in_progress', project: 'p1', blockedReason: 'waiting' });
    const r = await run();
    expect(r.total).toBe(0);
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

describe('computeInbox — chat questions', () => {
  it('parses a reply marker into chat, summary and Open chat URL', async () => {
    await seed({
      id: 'a-chat',
      slug: 'chat-q',
      status: 'in_progress',
      project: 'demo',
      comments: [
        {
          id: 'cq1',
          timestamp: '2026-06-15T00:00:00Z',
          author: 'claude',
          type: 'question',
          body: 'Which name?\n\n<!-- syntaur-chat kind="reply" item="item-9" turn="turn-1" -->',
          resolved: false,
        },
      ],
    });
    const r = await run({ dashboardUrl: 'http://localhost:4888' });
    const q = r.items.find((i) => i.category === 'question')!;
    expect(q.chat).toEqual({ kind: 'reply', itemId: 'item-9', turnId: 'turn-1', agentId: 'claude' });
    expect(q.summary).toBe('Which name?');
    expect(q.body).toBe('Which name?');
    expect(q.action).toEqual({
      verb: 'Open chat',
      command: 'http://localhost:4888/t/ACH-1?tab=chat#item-9',
    });
  });

  it('leaves plain questions on the Answer command', async () => {
    await seed({
      id: 'a-plain',
      slug: 'plain-q',
      status: 'in_progress',
      project: 'demo',
      comments: [
        {
          id: 'pq1',
          timestamp: '2026-06-15T00:00:00Z',
          author: 'human',
          type: 'question',
          body: 'Still blocked?',
          resolved: false,
        },
      ],
    });
    const r = await run();
    const q = r.items.find((i) => i.category === 'question')!;
    expect(q.chat).toBeUndefined();
    expect(q.action.verb).toBe('Answer');
  });

  it('builds chat URLs from ticket id', async () => {
    await seed({
      id: 'STD-1',
      slug: 'solo-chat',
      status: 'in_progress',
      project: 'demo',
      comments: [
        {
          id: 'sq1',
          timestamp: '2026-06-15T00:00:00Z',
          author: 'claude',
          type: 'question',
          body: 'Ready?\n\n<!-- syntaur-chat kind="permission" item="perm-1" -->',
          resolved: false,
        },
      ],
    });
    const r = await run({ dashboardUrl: 'http://test.local:4800' });
    const q = r.items.find((i) => i.category === 'question')!;
    expect(q.action.command).toBe(
      'http://test.local:4800/t/STD-1?tab=chat#perm-1',
    );
  });

  it('chat question body carries full marker-stripped text; summary is clipped', async () => {
    const longText = 'A'.repeat(200);
    await seed({
      id: 'a-long',
      slug: 'long-q',
      status: 'in_progress',
      project: 'demo',
      comments: [
        {
          id: 'lq1',
          timestamp: '2026-06-15T00:00:00Z',
          author: 'claude',
          type: 'question',
          body: `${longText}\n\n<!-- syntaur-chat kind="reply" item="item-long" turn="turn-2" -->`,
          resolved: false,
        },
      ],
    });
    const r = await run();
    const q = r.items.find((i) => i.category === 'question')!;
    expect(q.body).toBe(longText);
    expect(q.summary).toBe(`${'A'.repeat(137)}...`);
    expect(q.summary.length).toBeLessThanOrEqual(140);
  });

  it('question body preserves paragraph breaks; summary collapses whitespace', async () => {
    const paragraphBody = 'First paragraph.\n\nSecond paragraph.';
    await seed({
      id: 'a-para',
      slug: 'para-q',
      status: 'in_progress',
      project: 'demo',
      comments: [
        {
          id: 'pq1',
          timestamp: '2026-06-15T00:00:00Z',
          author: 'claude',
          type: 'question',
          body: `${paragraphBody}\n\n<!-- syntaur-chat kind="reply" item="item-para" turn="turn-1" -->`,
          resolved: false,
        },
      ],
    });
    const r = await run();
    const q = r.items.find((i) => i.category === 'question')!;
    expect(q.body).toBe(paragraphBody);
    expect(q.body).toContain('\n\n');
    expect(q.summary).toBe('First paragraph. Second paragraph.');
    expect(q.summary).not.toContain('\n');
  });
});

// ── max-age window ─────────────────────────────────────────────────────────────

describe('computeInbox — maxAgeMs', () => {
  it('drops an older review and keeps a newer one', async () => {
    await seed({
      id: 'old-rev',
      slug: 'old-rev',
      status: 'review',
      project: 'p1',
      statusHistory: ['- at: "2026-06-01T00:00:00Z"', '  to: review', '  command: review'],
    });
    await seed({
      id: 'new-rev',
      slug: 'new-rev',
      status: 'review',
      project: 'p1',
      statusHistory: ['- at: "2026-06-15T00:00:00Z"', '  to: review', '  command: review'],
    });
    const r = await run({ maxAgeMs: 7 * 86_400_000 });
    expect(r.items.map((i) => i.ticketSlug)).toEqual(['new-rev']);
    expect(r.total).toBe(1);
    expect(r.counts.review).toBe(1);
  });

  it('keeps a tier-0 card row older than the window', async () => {
    const permId = 'perm-old';
    const marker = formatChatQuestionMarker({ kind: 'permission', itemId: permId });
    await seed({
      id: 'a-old-card',
      slug: 'old-card',
      status: 'in_progress',
      project: 'p1',
      comments: [
        {
          id: 'c-old-card',
          timestamp: '2026-06-01T00:00:00Z',
          author: 'cursor',
          type: 'question',
          body: `Waiting\n\n${marker}`,
          resolved: false,
        },
      ],
    });
    const lookup = new Map<string, ChatItem>([[permId, permissionItem(permId, 'a-old-card')]]);
    const r = await run({
      maxAgeMs: 1 * 86_400_000,
      lookupChatItem: (id) => lookup.get(id) ?? null,
    });
    expect(r.items).toHaveLength(1);
    expect(r.items[0].ticketSlug).toBe('old-card');
    expect(r.total).toBe(1);
  });
});

// ── snoozes ────────────────────────────────────────────────────────────────────

describe('computeInbox — snoozes', () => {
  async function reviewRow(slug: string, id: string, since: string) {
    await seed({
      id,
      slug,
      status: 'review',
      project: 'p1',
      statusHistory: [`- at: "${since}"`, '  to: review', '  command: review'],
      updated: '2026-06-01T00:00:00Z',
    });
    const r = await run();
    return r.items.find((i) => i.ticketSlug === slug)!;
  }

  it('hides a snoozed review from items/counts/total', async () => {
    await reviewRow('snoozed-rev', 'sn-r', '2026-06-01T00:00:00Z');
    const item = (await run()).items.find((i) => i.ticketSlug === 'snoozed-rev')!;
    const key = inboxRowKey(item);
    const until = new Date(NOW + 7 * 86_400_000).toISOString();
    const snoozes: SnoozeMap = {
      [key]: { until, fingerprint: rowFingerprint(item), createdAt: new Date(NOW).toISOString() },
    };
    const r = await run({ snoozes });
    expect(r.items).toHaveLength(0);
    expect(r.total).toBe(0);
    expect(r.snoozedCount).toBe(1);
  });

  it('includes snoozed rows when includeSnoozed is set', async () => {
    const item = await reviewRow('show-snoozed', 'ss-r', '2026-06-01T00:00:00Z');
    const key = inboxRowKey(item);
    const until = new Date(NOW + 7 * 86_400_000).toISOString();
    const snoozes: SnoozeMap = {
      [key]: { until, fingerprint: rowFingerprint(item), createdAt: new Date(NOW).toISOString() },
    };
    const r = await run({ snoozes, includeSnoozed: true });
    expect(r.items).toHaveLength(1);
    expect(r.items[0].snoozed).toEqual({ until });
    expect(r.total).toBe(0);
    expect(r.snoozedCount).toBe(1);
  });

  it('lifts an until-change snooze when the fingerprint changes', async () => {
    await reviewRow('lift-rev', 'lf-r', '2026-06-01T00:00:00Z');
    const before = (await run()).items[0];
    const key = inboxRowKey(before);
    const snoozes: SnoozeMap = {
      [key]: {
        until: null,
        fingerprint: 'stale-fingerprint',
        createdAt: new Date(NOW).toISOString(),
      },
    };
    const r = await run({ snoozes });
    expect(r.items).toHaveLength(1);
    expect(r.liftedSnoozeKeys).toEqual([key]);
    expect(r.snoozedCount).toBe(0);
  });

  it('snoozes with a matching until-change entry', async () => {
    const item = await reviewRow('until-change', 'uc-r', '2026-06-01T00:00:00Z');
    const key = inboxRowKey(item);
    const snoozes: SnoozeMap = {
      [key]: {
        until: null,
        fingerprint: rowFingerprint(item),
        createdAt: new Date(NOW).toISOString(),
      },
    };
    const r = await run({ snoozes });
    expect(r.items).toHaveLength(0);
    expect(r.snoozedCount).toBe(1);
  });

  it('ignores a snooze entry keyed to a tier-0 card row', async () => {
    const permId = 'perm~colon~id';
    const marker = formatChatQuestionMarker({ kind: 'permission', itemId: permId });
    await seed({
      id: 'a-tier0',
      slug: 'tier0-row',
      status: 'in_progress',
      project: 'p1',
      comments: [
        {
          id: 'c-tier0',
          timestamp: '2026-06-01T00:00:00Z',
          author: 'cursor',
          type: 'question',
          body: `Waiting\n\n${marker}`,
          resolved: false,
        },
      ],
    });
    const lookup = new Map<string, ChatItem>([[permId, permissionItem(permId, 'a-tier0')]]);
    const r0 = await run({ lookupChatItem: (id) => lookup.get(id) ?? null });
    const item = r0.items[0];
    const key = inboxRowKey(item);
    const snoozes: SnoozeMap = {
      [key]: {
        until: new Date(NOW + 86_400_000).toISOString(),
        fingerprint: rowFingerprint(item),
        createdAt: new Date(NOW).toISOString(),
      },
    };
    const r = await run({ snoozes, lookupChatItem: (id) => lookup.get(id) ?? null });
    expect(r.items).toHaveLength(1);
    expect(r.snoozedCount).toBe(0);
  });
});

describe('inboxRowKey and rowFingerprint', () => {
  it('uses chat item id, compact-ts log rows, or category ticket-level keys', async () => {
    await seed({
      id: 'q-id',
      slug: 'q-slug',
      status: 'in_progress',
      project: 'p1',
      comments: [
        {
          id: 'comment-1',
          timestamp: '2026-06-15T00:00:00Z',
          author: 'h',
          type: 'question',
          body: 'open?',
          resolved: false,
        },
      ],
    });
    const plain = (await run()).items[0];
    expect(inboxRowKey(plain)).toBe('QID-1~20260615T000000Z');

    const permId = 'perm~chat~item';
    const marker = formatChatQuestionMarker({ kind: 'permission', itemId: permId });
    await seed({
      id: 'chat-id',
      slug: 'chat-slug',
      status: 'in_progress',
      project: 'p1',
      comments: [
        {
          id: 'c-chat',
          timestamp: '2026-06-15T00:00:00Z',
          author: 'cursor',
          type: 'question',
          body: `Waiting\n\n${marker}`,
          resolved: false,
        },
      ],
    });
    const lookup = new Map<string, ChatItem>([[permId, permissionItem(permId, 'chat-id')]]);
    const chat = (await run({ lookupChatItem: (id) => lookup.get(id) ?? null })).items.find(
      (i) => i.ticketSlug === 'chat-slug',
    )!;
    expect(inboxRowKey(chat)).toBe('perm~chat~item');
    expect(rowFingerprint(chat)).toContain(permId);

    await seed({ id: 'rev-id', slug: 'rev-slug', status: 'review', project: 'p1' });
    const review = (await run()).items.find((i) => i.ticketSlug === 'rev-slug')!;
    expect(inboxRowKey(review)).toBe('REV-1~review');
    expect(rowFingerprint(review)).toBe(`${review.since}|${review.ticketUpdated}|`);
  });
});
