import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { RequestHandler, Router } from 'express';
import { getTicketLogById } from '../dashboard/api.js';
import { createWriteRouter } from '../dashboard/api-write.js';
import { useHermeticSyntaurHome } from './hermetic-root.js';

useHermeticSyntaurHome();

let testDir: string;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'syntaur-api-log-test-'));
  if (process.env.SYNTAUR_HOME) {
    await writeFile(
      join(process.env.SYNTAUR_HOME, 'config.md'),
      `---\nversion: "2.0"\ndefaultProjectDir: ${testDir}\n---\n`,
    );
  }
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

async function seedFeatureTicket(journalBody: string): Promise<string> {
  const ticketDir = resolve(testDir, 'test-project', 'tickets', 'TP-1-demo');
  await mkdir(ticketDir, { recursive: true });
  await mkdir(resolve(testDir, 'test-project'), { recursive: true });
  await writeFile(
    resolve(testDir, 'test-project', 'project.md'),
    `---
id: proj-1
slug: test-project
title: Test Project
prefix: TP
nextTicket: 2
defaultTemplate: feature
archived: false
archivedAt: null
archivedReason: null
created: "2026-03-20T10:00:00Z"
updated: "2026-03-20T10:00:00Z"
tags: []
---

# Test Project`,
  );
  await writeFile(
    resolve(ticketDir, 'ticket.md'),
    `---
id: TP-1
slug: demo
title: Demo
status: in_progress
priority: medium
template: feature
created: "2026-03-20T10:00:00Z"
updated: "2026-03-20T10:00:00Z"
assignee: null
externalIds: []
depends_on: []
blocked: null
parked: null
workspace:
  repository: null
  worktree: null
  branch: null
  parentBranch: null
tags: []
---

# Demo`,
  );
  await writeFile(resolve(ticketDir, 'journal.md'), journalBody);
  return 'TP-1';
}

function getRouteHandler(router: Router, method: string, path: string): RequestHandler {
  const layer = (router as Router & {
    stack?: Array<{
      route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: RequestHandler }> };
    }>;
  }).stack?.find((candidate) => candidate.route?.path === path && candidate.route.methods[method]);
  if (!layer?.route?.stack?.[0]) throw new Error(`Route not found: ${method.toUpperCase()} ${path}`);
  return layer.route.stack[0].handle;
}

async function invokePostLog(body: Record<string, unknown>): Promise<{ statusCode: number; payload: unknown }> {
  const router = createWriteRouter(testDir);
  const handler = getRouteHandler(router, 'post', '/api/tickets/:id/log');
  let statusCode = 200;
  let payload: unknown = null;
  const res = {
    status(code: number) {
      statusCode = code;
      return this;
    },
    json(p: unknown) {
      payload = p;
      return this;
    },
  };
  await handler({ params: { id: 'TP-1' }, body, query: {} } as never, res as never, (() => undefined) as never);
  return { statusCode, payload };
}

describe('getTicketLogById', () => {
  it('returns null for an unknown ticket', async () => {
    expect(await getTicketLogById(testDir, 'missing')).toBeNull();
  });

  it('filters entries by type query', async () => {
    await seedFeatureTicket(`---
purpose: Append-only log
---

## 2026-04-07T12:00:00Z · progress · human

Did work.

## 2026-04-07T14:00:00Z · decision · human

Chose A.
`);
    const all = await getTicketLogById(testDir, 'TP-1');
    expect(all?.entries).toHaveLength(2);
    const filtered = await getTicketLogById(testDir, 'TP-1', 'decision');
    expect(filtered?.entries).toHaveLength(1);
    expect(filtered?.entries[0].type).toBe('decision');
  });

  it('includes keys on review entries', async () => {
    await seedFeatureTicket(`---
purpose: log
---

## 2026-04-07T15:00:00Z · review · human
verdict: approve · open: high=0 medium=0

Ship it.
`);
    const log = await getTicketLogById(testDir, 'TP-1');
    expect(log?.entries[0].keys?.verdict).toContain('approve');
  });
});

describe('POST /api/tickets/:id/log', () => {
  it('appends each allowed type to journal.md', async () => {
    await seedFeatureTicket(`---
purpose: log
---
`);
    for (const type of ['progress', 'decision', 'handoff', 'note'] as const) {
      const res = await invokePostLog({ type, body: `${type} body` });
      expect(res.statusCode).toBe(201);
    }
    const log = await getTicketLogById(testDir, 'TP-1');
    expect(log?.entries.length).toBeGreaterThanOrEqual(4);
  });

  it('validates review and answer payloads', async () => {
    await seedFeatureTicket(`---
purpose: log
---

## 2026-04-07T10:00:00Z · question · human

Open?
`);
    expect((await invokePostLog({ type: 'review', body: 'x' })).statusCode).toBe(400);
    expect((await invokePostLog({ type: 'answer', body: 'x' })).statusCode).toBe(400);
    const ok = await invokePostLog({
      type: 'answer',
      body: 'Resolved',
      answers: '2026-04-07T10:00:00Z',
    });
    expect(ok.statusCode).toBe(201);
  });
});
