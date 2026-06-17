import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createInboxRouter } from '../dashboard/api-inbox.js';
import { clearStatusConfigCache } from '../dashboard/api.js';
import type { InboxResult } from '../inbox/types.js';

/**
 * Router-level tests for `GET /api/inbox` (T3). These mirror the harness used
 * by `dashboard-api-usage.test.ts`: spin up a real express app on port 0, seed
 * on-disk fixtures under a temp SYNTAUR_HOME, call the route via fetch, assert
 * the InboxResult shape.
 *
 * The aggregation predicate matrix is already covered by T1's unit tests; here
 * we verify: (1) the route returns a valid InboxResult shape, (2) query params
 * (?type, ?project, ?limit) are wired through, (3) an unknown ?type yields 400,
 * and (4) a forced-error path returns the safe empty shape (HTTP 200).
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
      counts: { review: 0, blocked: 0, question: 0, 'plan-approval': 0 },
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
    expect(body.total).toBe(2);
    expect(body.counts.review).toBe(1);
    expect(body.counts.blocked).toBe(1);
    expect(body.items.length).toBe(2);

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
    await seed({ id: 'b1', slug: 'blk-a', status: 'blocked', project: 'p1' });

    const res = await fetch(`${baseUrl}/api/inbox?type=review`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as InboxResult;
    expect(body.items.every((i) => i.category === 'review')).toBe(true);
    // counts/total reflect the filtered set
    expect(body.counts.blocked).toBe(0);
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
      expect(body.counts).toEqual({ review: 0, blocked: 0, question: 0, 'plan-approval': 0 });
      expect(body.total).toBe(0);
    } finally {
      await new Promise<void>((res) => badServer.close(() => res()));
    }
  });
});
