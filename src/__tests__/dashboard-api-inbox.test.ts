import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createInboxRouter } from '../dashboard/api-inbox.js';
import { clearStatusConfigCache } from '../dashboard/api.js';
import { initSessionDb, closeSessionDb } from '../dashboard/session-db.js';
import { upsertChatItem } from '../db/chat-db.js';
import type { InboxResult } from '../inbox/types.js';
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
let assignmentsDir: string;
let server: Server;
let baseUrl: string;
let origSyntaurHome: string | undefined;

interface SeedOpts {
  id: string;
  slug: string;
  title?: string;
  status: string;
  project?: string | null; // null/undefined → standalone
}

async function seed(o: SeedOpts): Promise<void> {
  const standalone = o.project === undefined || o.project === null;
  const dir = standalone
    ? join(assignmentsDir, o.slug)
    : join(projectsDir, o.project as string, 'assignments', o.slug);
  await mkdir(dir, { recursive: true });

  const fm: string[] = [
    `id: ${o.id}`,
    `slug: ${o.slug}`,
    `title: "${o.title ?? o.slug}"`,
    `status: ${o.status}`,
    `project: ${standalone ? 'null' : o.project}`,
    `created: "2026-01-01T00:00:00Z"`,
    `updated: "2026-01-01T00:00:00Z"`,
  ];
  await writeFile(
    join(dir, 'assignment.md'),
    `---\n${fm.join('\n')}\n---\n# ${o.title ?? o.slug}\n`,
  );
}

async function seedQuestionComment(
  project: string,
  slug: string,
  _assignmentId: string,
  comment: {
    id: string;
    author: string;
    body: string;
    timestamp?: string;
  },
): Promise<void> {
  const ts = comment.timestamp ?? '2026-06-16T00:00:00Z';
  const dir = join(projectsDir, project, 'assignments', slug);
  await writeFile(
    join(dir, 'comments.md'),
    `---\nassignment: ${slug}\nentryCount: 1\nupdated: "${ts}"\n---\n\n# Comments\n\n${formatCommentEntry({
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
  assignmentsDir = join(sandbox, 'assignments');
  await mkdir(projectsDir, { recursive: true });
  await mkdir(assignmentsDir, { recursive: true });

  // A minimal config.md so getStatusConfig() resolves the default status config.
  await writeFile(
    join(sandbox, 'config.md'),
    `---\nversion: "2.0"\ndefaultProjectDir: ${projectsDir}\n---\n`,
  );

  origSyntaurHome = process.env.SYNTAUR_HOME;
  process.env.SYNTAUR_HOME = sandbox;
  // getStatusConfig() caches module-globally; clear so each test resolves fresh.
  clearStatusConfigCache();
  closeSessionDb();
  initSessionDb(join(sandbox, 'syntaur.db'));

  const app = express();
  app.use('/api', createInboxRouter(projectsDir, assignmentsDir));

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
  clearStatusConfigCache();
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
    });
  });

  it('returns items when review-status assignments exist', async () => {
    await mkdir(join(projectsDir, 'p1'), { recursive: true });
    await writeFile(
      join(projectsDir, 'p1', 'project.md'),
      `---\nslug: p1\ntitle: P1\ncreated: "2026-01-01"\nupdated: "2026-01-01"\n---\n# P1\n`,
    );
    await seed({ id: 'r1', slug: 'rev-a', status: 'review', project: 'p1', title: 'Rev A' });
    await seed({ id: 'b1', slug: 'blk-a', status: 'blocked', project: 'p1', title: 'Blk A' });

    const res = await fetch(`${baseUrl}/api/inbox`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as InboxResult;
    expect(body.total).toBe(1);
    expect(body.counts.review).toBe(1);
    expect(body.items.length).toBe(1);

    const reviewItem = body.items.find((i) => i.category === 'review');
    expect(reviewItem).toBeDefined();
    expect(reviewItem!.assignmentSlug).toBe('rev-a');
    expect(reviewItem!.action.verb).toBe('Accept');
    expect(reviewItem!.action.command).toContain('syntaur complete rev-a');
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
    const dir = join(projectsDir, 'p1', 'assignments', 'chat-row');
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'assignment.md'),
      `---\nid: q-chat\nslug: chat-row\ntitle: Chat row\nstatus: in_progress\nproject: p1\ncreated: "2026-01-01"\nupdated: "2026-01-01"\n---\n# Chat row\n`,
    );
    const marker = formatChatQuestionMarker({
      kind: 'reply',
      itemId: 'turn-1:1',
      turnId: 'turn-1',
    });
    await writeFile(
      join(dir, 'comments.md'),
      `---\nassignment: chat-row\nentryCount: 1\nupdated: "2026-06-16T00:00:00Z"\n---\n\n# Comments\n\n${formatCommentEntry({
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
      `${baseUrl}/projects/p1/assignments/chat-row?tab=chat#turn-1:1`,
    );
    expect(item.card).toBeUndefined();
  });

  it('returns safe empty shape (HTTP 200) on a forced internal error', async () => {
    // Spin up a router pointing at a non-existent projectsDir to trigger an
    // internal error path — the router must catch it and return the safe shape.
    const badApp = express();
    badApp.use('/api', createInboxRouter('/nonexistent/__does_not_exist__', null));
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
    } finally {
      await new Promise<void>((res) => badServer.close(() => res()));
    }
  });
});

describe('GET /api/inbox — card enrichment', () => {
  const ASSIGNMENT_ID = 'perm-assignment';
  const SESSION_KEY = `${ASSIGNMENT_ID}:cursor`;

  beforeEach(async () => {
    await mkdir(join(projectsDir, 'p1'), { recursive: true });
    await writeFile(
      join(projectsDir, 'p1', 'project.md'),
      `---\nslug: p1\ntitle: P1\ncreated: "2026-01-01"\nupdated: "2026-01-01"\n---\n# P1\n`,
    );
    await seed({ id: ASSIGNMENT_ID, slug: 'perm-row', status: 'in_progress', project: 'p1' });
  });

  it('enriches a permission row with requestId, options and settled:false', async () => {
    const itemId = 'perm-item-1';
    const marker = formatChatQuestionMarker({ kind: 'permission', itemId });
    await seedQuestionComment('p1', 'perm-row', ASSIGNMENT_ID, {
      id: 'cq-perm',
      author: 'cursor',
      body: `Waiting for permission\n\n${marker}`,
    });
    upsertChatItem(SESSION_KEY, {
      itemId,
      assignmentId: ASSIGNMENT_ID,
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
    await seedQuestionComment('p1', 'perm-row', ASSIGNMENT_ID, {
      id: 'cq-perm-2',
      author: 'cursor',
      body: `Waiting for permission\n\n${marker}`,
    });
    upsertChatItem(SESSION_KEY, {
      itemId,
      assignmentId: ASSIGNMENT_ID,
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
    await seedQuestionComment('p1', 'perm-row', ASSIGNMENT_ID, {
      id: 'cq-ask',
      author: 'cursor',
      body: `Pick one\n\n${marker}`,
    });
    upsertChatItem(SESSION_KEY, {
      itemId,
      assignmentId: ASSIGNMENT_ID,
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
    await seedQuestionComment('p1', 'perm-row', ASSIGNMENT_ID, {
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
      assignmentId: 'perm-assn',
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
      assignmentId: 'perm-assn2',
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
    await seedQuestionComment('p1', 'perm-row', ASSIGNMENT_ID, {
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
