import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { RequestHandler, Router } from 'express';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import {
  getOverview,
  listProjects,
  listWorkspaceRecords,
  invalidateRecordsCache,
} from '../dashboard/api.js';
import { createWriteRouter } from '../dashboard/api-write.js';
import { createStatusConfigRouter } from '../dashboard/api-status-config.js';
import { useHermeticSyntaurHome } from './hermetic-root.js';

// Hermetic root: these tests pass fixture configs; without a sandboxed
// SYNTAUR_HOME they read the developer’s real ~/.syntaur (ambient workflows
// dir + stages-migrated marker) — false DUAL_SOURCE errors post-2026-07-21.
useHermeticSyntaurHome();

let testDir: string;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'syntaur-cache-test-'));
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
blockedReason: null
workspace:
  repository: null
  worktreePath: null
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
  await writeFile(resolve(ticketDir, 'ticket.md'), ticketMd('test-ticket', status), 'utf-8');
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
    await seedProjectWithTicket('pending');
    const ticketPath = resolve(testDir, 'test-project', 'tickets', `${TEST_TICKET_ID}-test-ticket`, 'ticket.md');

    // Warm the cache.
    const first = await getOverview(testDir);
    expect(first.stats.inProgressTickets).toBe(0);

    // Mutate the file directly on disk, bypassing every router (so nothing
    // invalidates). A live (non-cached) read would see in_progress.
    await writeFile(ticketPath, ticketMd('test-ticket', 'in_progress'), 'utf-8');

    // Cache is still serving the warm snapshot — proves it is not re-fanning out.
    const cached = await getOverview(testDir);
    expect(cached.stats.inProgressTickets).toBe(0);

    // After invalidation the next read rebuilds and reflects the on-disk change.
    invalidateRecordsCache();
    const fresh = await getOverview(testDir);
    expect(fresh.stats.inProgressTickets).toBe(1);
  });

  it('shares one snapshot across listProjects and getOverview', async () => {
    await seedProjectWithTicket('pending');
    const projectMdPath = resolve(testDir, 'test-project', 'project.md');

    // Warm via listProjects.
    const projects = await listProjects(testDir);
    expect(projects.map((p) => p.title)).toEqual(['Test Project']);

    // Rename the title on disk without invalidating.
    await writeFile(projectMdPath, projectMd('test-project', 'Renamed Project'), 'utf-8');

    // getOverview reuses the same cached records — still the old title.
    const overview = await getOverview(testDir);
    expect(overview.recentProjects[0]?.title).toBe('Test Project');

    invalidateRecordsCache();
    const afterInvalidate = await listProjects(testDir);
    expect(afterInvalidate.map((p) => p.title)).toEqual(['Renamed Project']);
  });

  it('returns fresh data immediately after a dashboard write (no stale-read-after-write)', async () => {
    await seedProjectWithTicket('pending');
    const router = createWriteRouter(testDir);

    // Warm the cache with the pending state.
    const before = await getOverview(testDir);
    expect(before.stats.inProgressTickets).toBe(0);

    // Mutate through the real write router; its invalidation wrapper must clear
    // the cache synchronously before this returns — no watcher debounce window.
    const status = await invokeRoute(
      router,
      'patch',
      '/api/tickets/:id',
      { id: TEST_TICKET_ID },
      { content: ticketMd('test-ticket', 'in_progress') },
    );
    expect(status).toBe(200);

    // The very next read reflects the write with no manual invalidation.
    const after = await getOverview(testDir);
    expect(after.stats.inProgressTickets).toBe(1);
  });

  it('invalidates the records cache after a status-config mutation', async () => {
    await seedProjectWithTicket('pending');
    const ticketPath = resolve(testDir, 'test-project', 'tickets', `${TEST_TICKET_ID}-test-ticket`, 'ticket.md');
    const router = createStatusConfigRouter(testDir, null);

    // Warm the cache with the pending state.
    const before = await getOverview(testDir);
    expect(before.stats.inProgressTickets).toBe(0);

    // Mutate on disk, bypassing every router.
    await writeFile(ticketPath, ticketMd('test-ticket', 'in_progress'), 'utf-8');

    // A malformed body short-circuits to 400 before any global status-config
    // read/write, but it must still run the invalidation wrapper's `finally` —
    // proving the status-config router is wired with installRecordsInvalidation.
    const status = await invokeRoute(router, 'post', '/', {}, {});
    expect(status).toBe(400);

    // The next read reflects the on-disk change → the cache was cleared.
    const after = await getOverview(testDir);
    expect(after.stats.inProgressTickets).toBe(1);
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
          'worktreePath: null\n  branch: null',
          'worktreePath: /tmp/wt\n  branch: feature-x',
        ),
      'utf-8',
    );

    const records = await listWorkspaceRecords(testDir);
    const match = records.find((r) => r.ticketSlug === 'has-worktree');
    expect(match).toMatchObject({
      projectSlug: 'wsp',
      worktreePath: '/tmp/wt',
      branch: 'feature-x',
    });
  });
});
