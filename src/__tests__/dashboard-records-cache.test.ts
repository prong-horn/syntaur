import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { RequestHandler, Router } from 'express';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { join, join as joinPath, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import {
  listTicketsBoard,
  listProjects,
  listWorkspaceRecords,
  invalidateRecordsCache,
  readCachedLogEntries,
} from '../dashboard/api.js';
import { createWriteRouter } from '../dashboard/api-write.js';
import { useHermeticSyntaurHome } from './hermetic-root.js';

// Hermetic root: these tests pass fixture configs; without a sandboxed
// SYNTAUR_HOME they read the developer’s real ~/.syntaur (ambient workflows
// dir + stages-migrated marker) — false DUAL_SOURCE errors post-2026-07-21.
useHermeticSyntaurHome();

let testDir: string;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'syntaur-cache-test-'));
  if (process.env.SYNTAUR_HOME) {
    await writeFile(
      joinPath(process.env.SYNTAUR_HOME, 'config.md'),
      `---\nversion: "2.0"\ndefaultProjectDir: ${testDir}\n---\n`,
    );
  }
  // Records cache is module-global; clear it so a prior test's snapshot for a
  // (now-deleted) tmp dir can never bleed into this one.
  invalidateRecordsCache();
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
  invalidateRecordsCache();
});

function projectMd(slug: string, title: string): string {
  return `---
id: ${slug}-id
slug: ${slug}
title: ${title}
archived: false
archivedAt: null
archivedReason: null
created: "2026-03-20T10:00:00Z"
updated: "2026-03-20T10:00:00Z"
tags: []
---

# ${title}`;
}

const TEST_TICKET_ID = 'TST-1';

function ticketMd(slug: string, status: string): string {
  return `---
id: ${TEST_TICKET_ID}
slug: ${slug}
title: ${slug}
status: ${status}
priority: medium
created: "2026-03-20T10:00:00Z"
updated: "2026-03-20T10:00:00Z"
assignee: codex-1
externalIds: []
depends_on: []
blocked: null
workspace:
  repository: null
  worktree: null
  branch: null
  parentBranch: null
tags: []
---

# ${slug}`;
}

async function seedProjectWithTicket(status: string): Promise<string> {
  const projectDir = resolve(testDir, 'test-project');
  const ticketDir = resolve(projectDir, 'tickets', `${TEST_TICKET_ID}-test-ticket`);
  await mkdir(ticketDir, { recursive: true });
  await writeFile(resolve(projectDir, 'project.md'), projectMd('test-project', 'Test Project'), 'utf-8');
  await writeFile(resolve(ticketDir, 'ticket.md'), ticketMd(`${TEST_TICKET_ID}-test-ticket`, status), 'utf-8');
  return resolve(ticketDir, 'ticket.md');
}

// Minimal direct-handler invocation matching dashboard-write.test.ts so a
// mutation runs through the real write router (and its invalidation wrapper).
function getRouteHandler(router: Router, method: string, path: string): RequestHandler {
  const layer = (router as Router & {
    stack?: Array<{
      route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: RequestHandler }> };
    }>;
  }).stack?.find((candidate) => candidate.route?.path === path && candidate.route.methods[method]);
  if (!layer?.route?.stack?.length) throw new Error(`Route not found: ${method.toUpperCase()} ${path}`);
  // The invalidation wrapper is the terminal handler — invoke the last layer.
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

async function invokeRoute(
  router: Router,
  method: 'patch' | 'post',
  path: string,
  params: Record<string, string>,
  body: unknown,
): Promise<number> {
  const handler = getRouteHandler(router, method, path);
  let statusCode = 200;
  const res = {
    statusCode: 200,
    status(code: number) { this.statusCode = code; statusCode = code; return this; },
    json() { return this; },
  };
  await handler({ params, body, query: {} } as never, res as never, (() => undefined) as never);
  return statusCode;
}

describe('records cache', () => {
  it('serves a cached snapshot until explicitly invalidated', async () => {
    await seedProjectWithTicket('backlog');
    const ticketPath = resolve(testDir, 'test-project', 'tickets', `${TEST_TICKET_ID}-test-ticket`, 'ticket.md');

    // Warm the cache.
    const first = await listTicketsBoard(testDir);
    expect(first.tickets[0]?.status).toBe('backlog');

    // Mutate the file directly on disk, bypassing every router (so nothing
    // invalidates). A live (non-cached) read would see in_progress.
    await writeFile(ticketPath, ticketMd(`${TEST_TICKET_ID}-test-ticket`, 'in_progress'), 'utf-8');

    // Cache is still serving the warm snapshot — proves it is not re-fanning out.
    const cached = await listTicketsBoard(testDir);
    expect(cached.tickets[0]?.status).toBe('backlog');

    // After invalidation the next read rebuilds and reflects the on-disk change.
    invalidateRecordsCache();
    const fresh = await listTicketsBoard(testDir);
    expect(fresh.tickets[0]?.status).toBe('in_progress');
  });

  it('shares one snapshot across listProjects and listTicketsBoard', async () => {
    await seedProjectWithTicket('backlog');
    const projectMdPath = resolve(testDir, 'test-project', 'project.md');

    // Warm via listProjects.
    const projects = await listProjects(testDir);
    expect(projects.map((p) => p.title)).toEqual(['Test Project']);

    // Rename the title on disk without invalidating.
    await writeFile(projectMdPath, projectMd('test-project', 'Renamed Project'), 'utf-8');

    // The board reuses the cached project record and title.
    const board = await listTicketsBoard(testDir);
    expect(board.tickets[0]?.projectTitle).toBe('Test Project');

    invalidateRecordsCache();
    const afterInvalidate = await listProjects(testDir);
    expect(afterInvalidate.map((p) => p.title)).toEqual(['Renamed Project']);
  });

  it('returns fresh data immediately after a dashboard write (no stale-read-after-write)', async () => {
    await seedProjectWithTicket('ready');
    const router = createWriteRouter(testDir);

    // Warm the cache with the ready state.
    const before = await listTicketsBoard(testDir);
    expect(before.tickets[0]?.status).toBe('ready');

    // Mutate through the real write router; its invalidation wrapper must clear
    // the cache synchronously before this returns — no watcher debounce window.
    const status = await invokeRoute(
      router,
      'post',
      '/api/tickets/:id/verbs/:verb',
      { id: TEST_TICKET_ID, verb: 'start' },
      {},
    );
    expect(status).toBe(200);

    // The very next read reflects the write with no manual invalidation.
    const after = await listTicketsBoard(testDir);
    expect(after.tickets[0]?.status).toBe('in_progress');
  });

  it('derives workspace records from the cache without a second fan-out', async () => {
    const projectDir = resolve(testDir, 'wsp');
    const ticketDir = resolve(projectDir, 'tickets', 'WSP-1-has-worktree');
    await mkdir(ticketDir, { recursive: true });
    await writeFile(resolve(projectDir, 'project.md'), projectMd('wsp', 'WSP'), 'utf-8');
    await writeFile(
      resolve(ticketDir, 'ticket.md'),
      ticketMd('has-worktree', 'in_progress')
        .replace(`id: ${TEST_TICKET_ID}`, 'id: WSP-1')
        .replace(
          'worktree: null\n  branch: null',
          'worktree: /tmp/wt\n  branch: feature-x',
        ),
      'utf-8',
    );

    const records = await listWorkspaceRecords(testDir);
    const match = records.find((r) => r.ticketSlug === 'has-worktree');
    expect(match).toMatchObject({
      projectSlug: 'wsp',
      worktree: '/tmp/wt',
      branch: 'feature-x',
    });
  });

  it('reuses log parse cache until invalidation', async () => {
    const ticketDir = resolve(testDir, 'test-project', 'tickets', `${TEST_TICKET_ID}-test-ticket`);
    await seedProjectWithTicket('backlog');
    const journalPath = resolve(ticketDir, 'journal.md');
    await writeFile(
      journalPath,
      `---
purpose: log
---

## 2026-04-07T12:00:00Z · progress · human

First.
`,
    );

    const first = await readCachedLogEntries(journalPath);
    expect(first).toHaveLength(1);

    const cached = await readCachedLogEntries(journalPath);
    expect(cached).toHaveLength(1);

    await writeFile(
      journalPath,
      `---
purpose: log
---

## 2026-04-07T12:00:00Z · progress · human

First.

## 2026-04-07T13:00:00Z · progress · human

Second.
`,
    );

    invalidateRecordsCache();
    const fresh = await readCachedLogEntries(journalPath);
    expect(fresh).toHaveLength(2);
  });
});
