import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createInboxRouter } from '../dashboard/api-inbox.js';
import { clearStageTableCache } from '../dashboard/api.js';
import { initSessionDb, closeSessionDb } from '../dashboard/session-db.js';
import { upsertChatItem } from '../db/chat-db.js';
import { inboxRowKey } from '../inbox/index.js';
import type { InboxResult } from '../inbox/types.js';
import { readFile } from 'node:fs/promises';
import { formatCommentEntry } from '../templates/index.js';
import { formatChatQuestionMarker } from '../chat/questions.js';

/**
 * Router-level tests for `GET /api/inbox` (T3). These mirror the harness used
 * by `dashboard-api-usage.test.ts`: spin up a real express app on port 0, seed
 * on-disk fixtures under a temp SYNTAUR_HOME, call the route via fetch, assert
 * the InboxResult shape.
 *
 * The aggregation predicate matrix is already covered by T1's unit tests; here
 * we verify: (1) the route returns a valid InboxResult shape, (2) query params
 * (?type, ?project, ?limit) are wired through, (3) an unknown ?type yields 400,
 * (4) a forced-error path returns the safe empty shape (HTTP 200), and (5) card
 * enrichment for permission/ask chat rows.
 */

let sandbox: string;
let projectsDir: string;
let server: Server;
let baseUrl: string;
let origSyntaurHome: string | undefined;

interface SeedOpts {
  id: string;
  slug: string;
  title?: string;
  status: string;
  project?: string;
  statusHistory?: string[];
  updated?: string;
  planFiles?: Record<string, string>;
}

function toTicketId(id: string, slug: string): string {
  if (/^[A-Z]{2,5}-\d+$/.test(id)) return id;
  const letters = id.replace(/[^A-Za-z]/g, '').toUpperCase().padEnd(2, 'X').slice(0, 3);
  const num = (id.match(/\d+/) ?? slug.match(/\d+/) ?? ['1'])[0];
  return `${letters}-${num}`;
}

async function seed(o: SeedOpts): Promise<void> {
  const project = o.project ?? 'p1';
  const ticketId = toTicketId(o.id, o.slug);
  const dir = join(projectsDir, project, 'tickets', `${ticketId}-${o.slug}`);
  await mkdir(dir, { recursive: true });

  const fm: string[] = [
    `id: ${ticketId}`,
    `slug: ${o.slug}`,
    `title: "${o.title ?? o.slug}"`,
    `status: ${o.status}`,
    `project: ${project}`,
    `created: "2026-01-01T00:00:00Z"`,
    `updated: "${o.updated ?? '2026-01-01T00:00:00Z'}"`,
  ];
  if (o.statusHistory) {
    fm.push('statusHistory:');
    fm.push(...o.statusHistory.map((l) => `  ${l}`));
  }
  if (o.planFiles) {
    const planFile = Object.keys(o.planFiles)[0]!;
    fm.push('plan:');
    fm.push(`  file: ${planFile}`);
    fm.push('  approvedDigest: null');
    fm.push('  approvedAt: null');
    fm.push('  approvedBy: null');
  }
  await writeFile(
    join(dir, 'ticket.md'),
    `---\n${fm.join('\n')}\n---\n# ${o.title ?? o.slug}\n`,
  );
  if (o.planFiles) {
    for (const [name, content] of Object.entries(o.planFiles)) {
      await writeFile(join(dir, name), content);
    }
  }
}

async function seedQuestionComment(
  project: string,
  slug: string,
  _ticketId: string,
  comment: {
    id: string;
    author: string;
    body: string;
    timestamp?: string;
  },
): Promise<void> {
  const ts = comment.timestamp ?? '2026-06-16T00:00:00Z';
  const ticketId = toTicketId(_ticketId, slug);
  const dir = join(projectsDir, project, 'tickets', `${ticketId}-${slug}`);
  await writeFile(
    join(dir, 'comments.md'),
    `---\nticket: ${slug}\nentryCount: 1\nupdated: "${ts}"\n---\n\n# Comments\n\n${formatCommentEntry({
      id: comment.id,
      timestamp: ts,
      author: comment.author,
      type: 'question',
      body: comment.body,
      resolved: false,
    })}\n`,
  );
}

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'syntaur-api-inbox-'));
  projectsDir = join(sandbox, 'projects');
  await mkdir(projectsDir, { recursive: true });

  // A minimal config.md so getStageTableConfig() resolves the default status config.
  await writeFile(
    join(sandbox, 'config.md'),
    `---\nversion: "2.0"\ndefaultProjectDir: ${projectsDir}\n---\n`,
  );

  origSyntaurHome = process.env.SYNTAUR_HOME;
  process.env.SYNTAUR_HOME = sandbox;
  // getStageTableConfig() caches module-globally; clear so each test resolves fresh.
  clearStageTableCache();
  closeSessionDb();
  initSessionDb(join(sandbox, 'syntaur.db'));

  const app = express();
  app.use(express.json());
  app.use('/api', createInboxRouter(projectsDir));

  await new Promise<void>((res) => {
    server = app.listen(0, '127.0.0.1', () => res()) as Server;
  });
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterEach(async () => {
  await new Promise<void>((res) => server.close(() => res()));
  closeSessionDb();
  if (origSyntaurHome === undefined) delete process.env.SYNTAUR_HOME;
  else process.env.SYNTAUR_HOME = origSyntaurHome;
  clearStageTableCache();
  await rm(sandbox, { recursive: true, force: true });
});

describe('GET /api/inbox', () => {
  it('returns a valid InboxResult shape for an empty inbox', async () => {
    const res = await fetch(`${baseUrl}/api/inbox`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as InboxResult;
    expect(body).toEqual({
      items: [],
      counts: { question: 0, review: 0, 'plan-approval': 0 },
      total: 0,
      snoozedCount: 0,
      liftedSnoozeKeys: [],
    });
  });

  it('returns items when review-status tickets exist', async () => {
    await mkdir(join(projectsDir, 'p1'), { recursive: true });
    await writeFile(
      join(projectsDir, 'p1', 'project.md'),
      `---\nslug: p1\ntitle: P1\ncreated: "2026-01-01"\nupdated: "2026-01-01"\n---\n# P1\n`,
    );
    await seed({ id: 'r1', slug: 'rev-a', status: 'review', project: 'p1', title: 'Rev A' });
    await seed({ id: 'b1', slug: 'blk-a', status: 'in_progress', project: 'p1', title: 'Blk A' });

    const res = await fetch(`${baseUrl}/api/inbox`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as InboxResult;
    expect(body.total).toBe(1);
    expect(body.counts.review).toBe(1);
    expect(body.items.length).toBe(1);

    const reviewItem = body.items.find((i) => i.category === 'review');
    expect(reviewItem).toBeDefined();
    expect(reviewItem!.ticketSlug).toBe('rev-a');
    expect(reviewItem!.action.verb).toBe('Accept');
    expect(reviewItem!.action.command).toContain('syntaur done rev-a');
  });

  it('?type=review filters to only review items', async () => {
    await mkdir(join(projectsDir, 'p1'), { recursive: true });
    await writeFile(
      join(projectsDir, 'p1', 'project.md'),
      `---\nslug: p1\ntitle: P1\ncreated: "2026-01-01"\nupdated: "2026-01-01"\n---\n# P1\n`,
    );
    await seed({ id: 'r1', slug: 'rev-a', status: 'review', project: 'p1' });
    await seed({ id: 'q1', slug: 'qs-a', status: 'in_progress', project: 'p1' });

    const res = await fetch(`${baseUrl}/api/inbox?type=review`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as InboxResult;
    expect(body.items.every((i) => i.category === 'review')).toBe(true);
    expect(body.counts.question).toBe(0);
  });

  it('?limit=1 truncates items to 1', async () => {
    await mkdir(join(projectsDir, 'p1'), { recursive: true });
    await writeFile(
      join(projectsDir, 'p1', 'project.md'),
      `---\nslug: p1\ntitle: P1\ncreated: "2026-01-01"\nupdated: "2026-01-01"\n---\n# P1\n`,
    );
    await seed({ id: 'r1', slug: 'rev-a', status: 'review', project: 'p1' });
    await seed({ id: 'r2', slug: 'rev-b', status: 'review', project: 'p1' });

    const res = await fetch(`${baseUrl}/api/inbox?limit=1`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as InboxResult;
    expect(body.items.length).toBe(1);
    // total/counts still reflect the full set
    expect(body.total).toBe(2);
    expect(body.counts.review).toBe(2);
  });

  it('unknown ?type returns HTTP 400 with a clear error', async () => {
    const res = await fetch(`${baseUrl}/api/inbox?type=bogus`);
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/Unknown inbox type/i);
    expect(body.error).toContain('"bogus"');
  });

  it('returns chat metadata and a host-scoped Open chat URL for a reply marker', async () => {
    await mkdir(join(projectsDir, 'p1'), { recursive: true });
    await writeFile(
      join(projectsDir, 'p1', 'project.md'),
      `---\nslug: p1\ntitle: P1\ncreated: "2026-01-01"\nupdated: "2026-01-01"\n---\n# P1\n`,
    );
    const dir = join(projectsDir, 'p1', 'tickets', 'chat-row');
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'ticket.md'),
      `---\nid: q-chat\nslug: chat-row\ntitle: Chat row\nstatus: in_progress\nproject: p1\ncreated: "2026-01-01"\nupdated: "2026-01-01"\n---\n# Chat row\n`,
    );
    const marker = formatChatQuestionMarker({
      kind: 'reply',
      itemId: 'turn-1:1',
      turnId: 'turn-1',
    });
    await writeFile(
      join(dir, 'comments.md'),
      `---\nticket: chat-row\nentryCount: 1\nupdated: "2026-06-16T00:00:00Z"\n---\n\n# Comments\n\n${formatCommentEntry({
        id: 'c9',
        timestamp: '2026-06-16T00:00:00Z',
        author: 'claude',
        type: 'question',
        body: `Which name?\n\n${marker}`,
        resolved: false,
      })}\n`,
    );

    const res = await fetch(`${baseUrl}/api/inbox?project=p1`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as InboxResult;
    expect(body.total).toBe(1);
    const item = body.items[0];
    expect(item.chat).toMatchObject({
      kind: 'reply',
      itemId: 'turn-1:1',
      turnId: 'turn-1',
      agentId: 'claude',
    });
    expect(item.action.verb).toBe('Open chat');
    expect(item.action.command).toBe(
      `${baseUrl}/t/${item.ticketId}?tab=chat#turn-1:1`,
    );
    expect(item.card).toBeUndefined();
  });

  it('returns safe empty shape (HTTP 200) on a forced internal error', async () => {
    // Spin up a router pointing at a non-existent projectsDir to trigger an
    // internal error path — the router must catch it and return the safe shape.
    const badApp = express();
    badApp.use('/api', createInboxRouter('/nonexistent/__does_not_exist__'));
    const badServer: Server = await new Promise((res) => {
      const s = badApp.listen(0, '127.0.0.1', () => res(s as Server));
    });
    const badAddr = badServer.address() as AddressInfo;
    const badUrl = `http://127.0.0.1:${badAddr.port}`;
    try {
      const r = await fetch(`${badUrl}/api/inbox`);
      expect(r.status).toBe(200);
      const body = await r.json() as InboxResult;
      // Safe empty shape — the exact convention from api-events.ts best-effort pattern.
      expect(body.items).toEqual([]);
      expect(body.counts).toEqual({ question: 0, review: 0, 'plan-approval': 0 });
      expect(body.total).toBe(0);
      expect(body.snoozedCount).toBe(0);
      expect(body.liftedSnoozeKeys).toEqual([]);
    } finally {
      await new Promise<void>((res) => badServer.close(() => res()));
    }
  });
});

describe('GET /api/inbox — card enrichment', () => {
  const TICKET_ID = 'perm-ticket';
  const SESSION_KEY = `${TICKET_ID}~cursor`;

  beforeEach(async () => {
    await mkdir(join(projectsDir, 'p1'), { recursive: true });
    await writeFile(
      join(projectsDir, 'p1', 'project.md'),
      `---\nslug: p1\ntitle: P1\ncreated: "2026-01-01"\nupdated: "2026-01-01"\n---\n# P1\n`,
    );
    await seed({ id: TICKET_ID, slug: 'perm-row', status: 'in_progress', project: 'p1' });
  });

  it('enriches a permission row with requestId, options and settled:false', async () => {
    const itemId = 'perm-item-1';
    const marker = formatChatQuestionMarker({ kind: 'permission', itemId });
    await seedQuestionComment('p1', 'perm-row', TICKET_ID, {
      id: 'cq-perm',
      author: 'cursor',
      body: `Waiting for permission\n\n${marker}`,
    });
    upsertChatItem(SESSION_KEY, {
      itemId,
      ticketId: TICKET_ID,
      turnId: 'turn-1',
      agentId: 'cursor',
      type: 'permission.request',
      ts: '2026-06-16T00:00:00Z',
      seqFirst: 1,
      seqLast: 1,
      sealed: false,
      requestId: 'req-perm-1',
      toolCall: { title: 'Run uname' },
      options: [
        { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'allow-always', name: 'Allow always', kind: 'allow_always' },
        { optionId: 'deny', name: 'Deny', kind: 'deny' },
      ],
    } as never);

    const res = await fetch(`${baseUrl}/api/inbox?project=p1`);
    const body = (await res.json()) as InboxResult;
    const row = body.items.find((i) => i.chat?.kind === 'permission')!;
    expect(row.card).toEqual({
      requestId: 'req-perm-1',
      kind: 'permission',
      options: [
        { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'allow-always', name: 'Allow always', kind: 'allow_always' },
        { optionId: 'deny', name: 'Deny', kind: 'deny' },
      ],
      settled: false,
    });
  });

  it('marks an answered permission card settled:true', async () => {
    const itemId = 'perm-item-2';
    const marker = formatChatQuestionMarker({ kind: 'permission', itemId });
    await seedQuestionComment('p1', 'perm-row', TICKET_ID, {
      id: 'cq-perm-2',
      author: 'cursor',
      body: `Waiting for permission\n\n${marker}`,
    });
    upsertChatItem(SESSION_KEY, {
      itemId,
      ticketId: TICKET_ID,
      turnId: 'turn-1',
      agentId: 'cursor',
      type: 'permission.request',
      ts: '2026-06-16T00:00:00Z',
      seqFirst: 1,
      seqLast: 1,
      sealed: true,
      requestId: 'req-perm-2',
      toolCall: { title: 'Run uname' },
      options: [{ optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' }],
      answer: 'allow-once',
    } as never);

    const res = await fetch(`${baseUrl}/api/inbox?project=p1`);
    const body = (await res.json()) as InboxResult;
    const row = body.items.find((i) => i.chat?.kind === 'permission')!;
    expect(row.card?.settled).toBe(true);
  });

  it('enriches an ask row with two choices', async () => {
    const itemId = 'ask-item-1';
    const marker = formatChatQuestionMarker({ kind: 'ask', itemId });
    await seedQuestionComment('p1', 'perm-row', TICKET_ID, {
      id: 'cq-ask',
      author: 'cursor',
      body: `Pick one\n\n${marker}`,
    });
    upsertChatItem(SESSION_KEY, {
      itemId,
      ticketId: TICKET_ID,
      turnId: 'turn-2',
      agentId: 'cursor',
      type: 'question',
      ts: '2026-06-16T00:00:00Z',
      seqFirst: 2,
      seqLast: 2,
      sealed: false,
      requestId: 'req-ask-1',
      text: 'Alpha or beta?',
      options: [
        { id: 'alpha', label: 'Alpha' },
        { id: 'beta', label: 'Beta' },
      ],
      answer: null,
    } as never);

    const res = await fetch(`${baseUrl}/api/inbox?project=p1`);
    const body = (await res.json()) as InboxResult;
    const row = body.items.find((i) => i.chat?.kind === 'ask')!;
    expect(row.card).toEqual({
      requestId: 'req-ask-1',
      kind: 'ask',
      options: [
        { id: 'alpha', label: 'Alpha' },
        { id: 'beta', label: 'Beta' },
      ],
      settled: false,
    });
  });

  it('returns card:null when the chat item is absent', async () => {
    const marker = formatChatQuestionMarker({ kind: 'permission', itemId: 'missing-item' });
    await seedQuestionComment('p1', 'perm-row', TICKET_ID, {
      id: 'cq-missing',
      author: 'cursor',
      body: `Waiting for permission\n\n${marker}`,
    });

    const res = await fetch(`${baseUrl}/api/inbox?project=p1`);
    const body = (await res.json()) as InboxResult;
    const row = body.items.find((i) => i.chat?.kind === 'permission')!;
    expect(row.card).toBeNull();
  });

  it('pins an unsettled permission row above an older reply row', async () => {
    const permItemId = 'perm-order-1';
    const replyItemId = 'reply-order-1';
    const permMarker = formatChatQuestionMarker({ kind: 'permission', itemId: permItemId });
    const replyMarker = formatChatQuestionMarker({
      kind: 'reply',
      itemId: replyItemId,
      turnId: 't1',
    });
    await seed({ id: 'perm-assn', slug: 'perm-order-row', status: 'in_progress', project: 'p1' });
    await seed({ id: 'reply-assn', slug: 'reply-order-row', status: 'in_progress', project: 'p1' });
    await seedQuestionComment('p1', 'reply-order-row', 'reply-assn', {
      id: 'cq-reply-order',
      author: 'claude',
      timestamp: '2026-06-01T00:00:00Z',
      body: `Need input\n\n${replyMarker}`,
    });
    await seedQuestionComment('p1', 'perm-order-row', 'perm-assn', {
      id: 'cq-perm-order',
      author: 'cursor',
      timestamp: '2026-06-15T00:00:00Z',
      body: `Waiting for permission\n\n${permMarker}`,
    });
    upsertChatItem(SESSION_KEY, {
      itemId: permItemId,
      ticketId: 'perm-assn',
      turnId: 'turn-1',
      agentId: 'cursor',
      type: 'permission.request',
      ts: '2026-06-16T00:00:00Z',
      seqFirst: 1,
      seqLast: 1,
      sealed: false,
      requestId: 'req-order-1',
      toolCall: { title: 'Run uname' },
      options: [{ optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' }],
    } as never);

    const res = await fetch(`${baseUrl}/api/inbox?project=p1`);
    const body = (await res.json()) as InboxResult;
    expect(body.items[0].chat?.kind).toBe('permission');
    expect(body.items[0].card?.settled).toBe(false);
  });

  it('demotes a settled permission card below an older reply row', async () => {
    const permItemId = 'perm-order-2';
    const replyItemId = 'reply-order-2';
    const permMarker = formatChatQuestionMarker({ kind: 'permission', itemId: permItemId });
    const replyMarker = formatChatQuestionMarker({
      kind: 'reply',
      itemId: replyItemId,
      turnId: 't1',
    });
    await seed({ id: 'perm-assn2', slug: 'perm-settled-row', status: 'in_progress', project: 'p1' });
    await seed({ id: 'reply-assn2', slug: 'reply-older-row', status: 'in_progress', project: 'p1' });
    await seedQuestionComment('p1', 'reply-older-row', 'reply-assn2', {
      id: 'cq-reply-order2',
      author: 'claude',
      timestamp: '2026-06-01T00:00:00Z',
      body: `Need input\n\n${replyMarker}`,
    });
    await seedQuestionComment('p1', 'perm-settled-row', 'perm-assn2', {
      id: 'cq-perm-order2',
      author: 'cursor',
      timestamp: '2026-06-15T00:00:00Z',
      body: `Waiting for permission\n\n${permMarker}`,
    });
    upsertChatItem(SESSION_KEY, {
      itemId: permItemId,
      ticketId: 'perm-assn2',
      turnId: 'turn-1',
      agentId: 'cursor',
      type: 'permission.request',
      ts: '2026-06-16T00:00:00Z',
      seqFirst: 1,
      seqLast: 1,
      sealed: true,
      requestId: 'req-order-2',
      toolCall: { title: 'Run uname' },
      options: [{ optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' }],
      answer: 'allow-once',
    } as never);

    const res = await fetch(`${baseUrl}/api/inbox?project=p1`);
    const body = (await res.json()) as InboxResult;
    expect(body.items[0].chat?.kind).toBe('reply');
    const permRow = body.items.find((i) => i.chat?.kind === 'permission')!;
    expect(permRow.card?.settled).toBe(true);
  });

  it('returns card:null with HTTP 200 when the session db is closed', async () => {
    const permItemId = 'perm-closed-db';
    const marker = formatChatQuestionMarker({ kind: 'permission', itemId: permItemId });
    await seedQuestionComment('p1', 'perm-row', TICKET_ID, {
      id: 'cq-closed-db',
      author: 'cursor',
      body: `Waiting for permission\n\n${marker}`,
    });
    closeSessionDb();

    const res = await fetch(`${baseUrl}/api/inbox?project=p1`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as InboxResult;
    const row = body.items.find((i) => i.chat?.kind === 'permission')!;
    expect(row.card).toBeNull();
  });
});

describe('GET /api/inbox — maxAgeDays', () => {
  const now = Date.now();
  const oldAt = new Date(now - 30 * 86_400_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const freshAt = new Date(now - 12 * 3_600_000).toISOString().replace(/\.\d{3}Z$/, 'Z');

  beforeEach(async () => {
    await mkdir(join(projectsDir, 'p1'), { recursive: true });
    await writeFile(
      join(projectsDir, 'p1', 'project.md'),
      `---\nslug: p1\ntitle: P1\ncreated: "2026-01-01"\nupdated: "2026-01-01"\n---\n# P1\n`,
    );
    await seed({
      id: 'old-r',
      slug: 'old-review',
      status: 'review',
      project: 'p1',
      statusHistory: [`- at: "${oldAt}"`, '  to: review', '  command: review'],
    });
    await seed({
      id: 'new-r',
      slug: 'new-review',
      status: 'review',
      project: 'p1',
      statusHistory: [`- at: "${freshAt}"`, '  to: review', '  command: review'],
    });
  });

  it('?maxAgeDays=1 hides an old review and keeps a fresh one', async () => {
    const res = await fetch(`${baseUrl}/api/inbox?maxAgeDays=1`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as InboxResult;
    expect(body.items.map((i) => i.ticketSlug)).toEqual(['new-review']);
    expect(body.total).toBe(1);
  });

  it('?maxAgeDays=abc returns 400', async () => {
    const res = await fetch(`${baseUrl}/api/inbox?maxAgeDays=abc`);
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/positive/i);
  });

  it('keeps an unsettled permission row older than the window', async () => {
    const permItemId = 'perm~old~window';
    const marker = formatChatQuestionMarker({ kind: 'permission', itemId: permItemId });
    await seed({ id: 'perm-a', slug: 'perm-old', status: 'in_progress', project: 'p1' });
    await seedQuestionComment('p1', 'perm-old', 'perm-a', {
      id: 'cq-perm-old',
      author: 'cursor',
      timestamp: oldAt,
      body: `Waiting\n\n${marker}`,
    });
    upsertChatItem('perm-a~cursor', {
      itemId: permItemId,
      ticketId: 'perm-a',
      turnId: 'turn-1',
      agentId: 'cursor',
      type: 'permission.request',
      ts: '2026-06-16T00:00:00Z',
      seqFirst: 1,
      seqLast: 1,
      sealed: false,
      requestId: 'req-old',
      toolCall: { title: 'Run uname' },
      options: [{ optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' }],
    } as never);

    const res = await fetch(`${baseUrl}/api/inbox?maxAgeDays=1&project=p1`);
    const body = (await res.json()) as InboxResult;
    const perm = body.items.find((i) => i.chat?.kind === 'permission');
    expect(perm).toBeDefined();
    expect(perm!.card?.settled).toBe(false);
  });
});

describe('PUT/DELETE /api/inbox/snoozes/:rowKey', () => {
  beforeEach(async () => {
    await mkdir(join(projectsDir, 'p1'), { recursive: true });
    await writeFile(
      join(projectsDir, 'p1', 'project.md'),
      `---\nslug: p1\ntitle: P1\ncreated: "2026-01-01"\nupdated: "2026-01-01"\n---\n# P1\n`,
    );
  });

  it('snoozes a plan-approval row and round-trips tilde keys', async () => {
    await seed({
      id: 'plan:uuid',
      slug: 'plan-check',
      status: 'planning',
      project: 'p1',
      planFiles: { 'plan.md': '# plan\n' },
    });
    const inbox = (await (await fetch(`${baseUrl}/api/inbox`)).json()) as InboxResult;
    const row = inbox.items.find((i) => i.ticketSlug === 'plan-check')!;
    const key = inboxRowKey(row);
    expect(key).toBe(`${toTicketId('plan:uuid', 'plan-check')}~plan-approval`);

    const putRes = await fetch(`${baseUrl}/api/inbox/snoozes/${encodeURIComponent(key)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ untilDays: 7 }),
    });
    expect(putRes.status).toBe(200);
    const putBody = await putRes.json() as { rowKey: string; until: string };
    expect(putBody.rowKey).toBe(key);
    expect(putBody.until).toMatch(/^\d{4}-/);

    const getRes = await fetch(`${baseUrl}/api/inbox`);
    const getBody = (await getRes.json()) as InboxResult;
    expect(getBody.items.find((i) => i.ticketSlug === 'plan-check')).toBeUndefined();
    expect(getBody.snoozedCount).toBe(1);

    const showRes = await fetch(`${baseUrl}/api/inbox?includeSnoozed=1`);
    const showBody = (await showRes.json()) as InboxResult;
    const flagged = showBody.items.find((i) => i.ticketSlug === 'plan-check');
    expect(flagged?.snoozed?.until).toBe(putBody.until);

    const delRes = await fetch(`${baseUrl}/api/inbox/snoozes/${encodeURIComponent(key)}`, {
      method: 'DELETE',
    });
    expect((await delRes.json()).removed).toBe(true);

    const back = (await (await fetch(`${baseUrl}/api/inbox`)).json()) as InboxResult;
    expect(back.items.find((i) => i.ticketSlug === 'plan-check')).toBeDefined();

    const del2 = await fetch(`${baseUrl}/api/inbox/snoozes/${encodeURIComponent(key)}`, {
      method: 'DELETE',
    });
    expect((await del2.json()).removed).toBe(false);
  });

  it('returns 409 for a tier-0 permission row', async () => {
    const permItemId = 'perm-snooze';
    const marker = formatChatQuestionMarker({ kind: 'permission', itemId: permItemId });
    await seed({ id: 'perm-a', slug: 'perm-row', status: 'in_progress', project: 'p1' });
    await seedQuestionComment('p1', 'perm-row', 'perm-a', {
      id: 'cq-perm',
      author: 'cursor',
      body: `Waiting\n\n${marker}`,
    });
    upsertChatItem('perm-a~cursor', {
      itemId: permItemId,
      ticketId: 'perm-a',
      turnId: 'turn-1',
      agentId: 'cursor',
      type: 'permission.request',
      ts: '2026-06-16T00:00:00Z',
      seqFirst: 1,
      seqLast: 1,
      sealed: false,
      requestId: 'req-1',
      toolCall: { title: 'Run uname' },
      options: [{ optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' }],
    } as never);

    const inbox = (await (await fetch(`${baseUrl}/api/inbox?project=p1`)).json()) as InboxResult;
    const row = inbox.items.find((i) => i.chat?.kind === 'permission')!;
    const key = inboxRowKey(row);
    const res = await fetch(`${baseUrl}/api/inbox/snoozes/${encodeURIComponent(key)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ untilDays: 1 }),
    });
    expect(res.status).toBe(409);
  });

  it('returns 400 when untilDays is a string', async () => {
    await seed({ id: 'r1', slug: 'rev', status: 'review', project: 'p1' });
    const inbox = (await (await fetch(`${baseUrl}/api/inbox`)).json()) as InboxResult;
    const key = inboxRowKey(inbox.items[0]);
    const res = await fetch(`${baseUrl}/api/inbox/snoozes/${encodeURIComponent(key)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ untilDays: '7' }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/positive number/i);
  });

  it('returns 400 when both or neither snooze fields are sent', async () => {
    await seed({ id: 'r1', slug: 'rev', status: 'review', project: 'p1' });
    const inbox = (await (await fetch(`${baseUrl}/api/inbox`)).json()) as InboxResult;
    const key = inboxRowKey(inbox.items[0]);
    const both = await fetch(`${baseUrl}/api/inbox/snoozes/${encodeURIComponent(key)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ untilDays: 1, untilChange: true }),
    });
    expect(both.status).toBe(400);
    const neither = await fetch(`${baseUrl}/api/inbox/snoozes/${encodeURIComponent(key)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(neither.status).toBe(400);
  });

  it('returns 404 for an unknown row key', async () => {
    const res = await fetch(`${baseUrl}/api/inbox/snoozes/${encodeURIComponent('bogus:key')}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ untilDays: 1 }),
    });
    expect(res.status).toBe(404);
  });

  it('lifts an until-change snooze when ticket updated changes', async () => {
    await seed({
      id: 'old-r',
      slug: 'old-review',
      status: 'review',
      project: 'p1',
      updated: '2025-01-01T00:00:00Z',
      statusHistory: ['- at: "2025-01-01T00:00:00Z"', '  to: review', '  command: review'],
    });
    const inbox = (await (await fetch(`${baseUrl}/api/inbox`)).json()) as InboxResult;
    const row = inbox.items.find((i) => i.ticketSlug === 'old-review')!;
    const key = inboxRowKey(row);

    const putRes = await fetch(`${baseUrl}/api/inbox/snoozes/${encodeURIComponent(key)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ untilChange: true }),
    });
    expect(putRes.status).toBe(200);

    let getBody = (await (await fetch(`${baseUrl}/api/inbox`)).json()) as InboxResult;
    expect(getBody.items.find((i) => i.ticketSlug === 'old-review')).toBeUndefined();

    const ticketId = toTicketId('old-r', 'old-review');
    const dir = join(projectsDir, 'p1', 'tickets', `${ticketId}-old-review`);
    const md = await readFile(join(dir, 'ticket.md'), 'utf-8');
    await writeFile(
      join(dir, 'ticket.md'),
      md.replace('updated: "2025-01-01T00:00:00Z"', 'updated: "2026-06-16T12:00:00Z"'),
    );

    getBody = (await (await fetch(`${baseUrl}/api/inbox`)).json()) as InboxResult;
    expect(getBody.items.find((i) => i.ticketSlug === 'old-review')).toBeDefined();

    const store = JSON.parse(await readFile(join(sandbox, 'inbox-snoozes.json'), 'utf-8'));
    expect(store[key]).toBeUndefined();
  });
});
