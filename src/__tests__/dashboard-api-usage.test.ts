import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import {
  initUsageDb,
  closeUsageDb,
  resetUsageDb,
  upsertEvent,
} from '../db/usage-db.js';
import {
  initSessionDb,
  closeSessionDb,
  resetSessionDb,
} from '../dashboard/session-db.js';
import { openEngagement, closeEngagementById } from '../db/engagement-db.js';
import type { TokenSnapshot } from '../db/engagement-tokens.js';
import { invalidateRecordsCache } from '../dashboard/api.js';
import { runRollup } from '../usage/rollup-runner.js';
import { createUsageRouter } from '../dashboard/api-usage.js';

let sandbox: string;
let projectsDir: string;
let assignmentsDir: string;
let server: ReturnType<typeof express>['listen'] extends (port: number) => infer T ? T : never;
let baseUrl: string;
let originalEnv: string | undefined;

/** Write a minimal project.md so listProjects/resolveWorkspaceMembers can see it. */
async function writeProject(slug: string, workspace: string | null): Promise<void> {
  const dir = resolve(projectsDir, slug);
  await mkdir(dir, { recursive: true });
  const ws = workspace === null ? '' : `\nworkspace: ${workspace}`;
  await writeFile(
    resolve(dir, 'project.md'),
    `---\nslug: ${slug}\ntitle: ${slug}\ncreated: "2026-05-01"\nupdated: "2026-05-01"${ws}\n---\n\n# ${slug}\n`,
    'utf-8',
  );
}

/** Write a minimal standalone assignment.md (folder name = id). */
async function writeStandalone(id: string, workspaceGroup: string | null, archived = false): Promise<void> {
  const dir = resolve(assignmentsDir, id);
  await mkdir(dir, { recursive: true });
  const wg = workspaceGroup === null ? '' : `\nworkspaceGroup: ${workspaceGroup}`;
  await writeFile(
    resolve(dir, 'assignment.md'),
    `---\nid: ${id}\nslug: ${id}\ntitle: ${id}\nstatus: pending\npriority: medium\ncreated: "2026-05-01T00:00:00Z"\nupdated: "2026-05-01T00:00:00Z"\narchived: ${archived}${wg}\ntags: []\n---\n\n# ${id}\n`,
    'utf-8',
  );
}

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'syntaur-api-usage-'));
  projectsDir = resolve(sandbox, 'projects');
  assignmentsDir = resolve(sandbox, 'assignments');
  originalEnv = process.env.SYNTAUR_HOME;
  process.env.SYNTAUR_HOME = sandbox;
  invalidateRecordsCache();
  resetUsageDb();
  resetSessionDb();
  initUsageDb();
  // Engagement windows (snapshot cost source) live in the SAME syntaur.db under
  // SYNTAUR_HOME; init the session db so the cost reader sees the engagement table.
  initSessionDb();

  const app = express();
  app.use('/api/usage', createUsageRouter(projectsDir, assignmentsDir));

  await new Promise<void>((res) => {
    server = app.listen(0, '127.0.0.1', () => res());
  });
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterEach(async () => {
  await new Promise<void>((res) => server.close(() => res()));
  closeUsageDb();
  closeSessionDb();
  if (originalEnv === undefined) delete process.env.SYNTAUR_HOME;
  else process.env.SYNTAUR_HOME = originalEnv;
  await rm(sandbox, { recursive: true, force: true });
});

/**
 * Seed one CLOSED engagement window so the snapshot-cost reader (M2) has a
 * per-assignment cost. open cost 0 → close cost `costDelta`, so the window cost
 * equals `costDelta`. Standalone (`projectSlug === ''`) stores `project_slug NULL`.
 */
function seedWindow(
  projectSlug: string,
  assignmentSlug: string,
  costDelta: number,
  model = 'claude-opus-4-7',
  endedAt = '2026-05-21T12:30:00.000Z',
): void {
  const startedAt = '2026-05-21T11:00:00.000Z';
  const snap = (cost: number): TokenSnapshot => ({
    models: { [model]: { input: 0, output: 0, cacheCreation: 0, cacheRead: 0, total: 0, cost } },
    collectorRunAt: null,
    capturedAt: '2026-05-21T12:00:00.000Z',
  });
  const row = openEngagement({
    sessionId: `win-${projectSlug}-${assignmentSlug}-${model}-${endedAt}`,
    projectSlug: projectSlug === '' ? null : projectSlug,
    assignmentSlug,
    stage: 'implement',
    startedAt,
    tokensAtOpen: snap(0),
  });
  closeEngagementById({
    id: row.id,
    startedAt,
    closeReason: 'switch',
    tokensAtClose: snap(costDelta),
    endedAt,
  });
}

function seed(
  projectSlug: string,
  assignmentSlug: string,
  totalTokens: number,
  totalCost: number,
  eventTs = '2026-05-21T12:00:00.000Z',
  model = 'claude-opus-4-7',
) {
  upsertEvent({
    sessionId: `${projectSlug}-${assignmentSlug}-${model}-${eventTs}`,
    model,
    tool: 'claude',
    eventTs,
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    totalTokens,
    totalCost,
    cwd: null,
    projectSlug,
    assignmentSlug,
    rawJson: null,
  });
}

describe('GET /api/usage', () => {
  it('returns daily + summary grouped by project', async () => {
    seed('p1', 'a1', 100, 0.5);
    seed('p1', 'a2', 200, 1.0);
    seed('p2', 'a1', 1000, 5.0);
    runRollup();

    const res = await fetch(`${baseUrl}/api/usage`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.daily.length).toBe(3);
    expect(body.summary.length).toBe(2);
    expect(body.summary[0].projectSlug).toBe('p2');
    expect(body.summary[0].totalTokens).toBe(1000);
    expect(body.summary[1].projectSlug).toBe('p1');
    expect(body.summary[1].totalTokens).toBe(300);
  });

  it('honors ?since= filter', async () => {
    seed('p', 'a', 100, 0.5, '2026-05-19T12:00:00.000Z');
    seed('p', 'a', 200, 0.5, '2026-05-21T12:00:00.000Z');
    runRollup();

    const res = await fetch(`${baseUrl}/api/usage?since=2026-05-20`);
    const body = await res.json();
    expect(body.daily.length).toBe(1);
  });
});

describe('GET /api/usage/projects/:projectSlug', () => {
  it('restricts to a single project and groups by assignment', async () => {
    seed('p1', 'a1', 100, 0.5);
    seed('p1', 'a2', 200, 1.0);
    seed('p2', 'a1', 300, 2.0);
    runRollup();

    const res = await fetch(`${baseUrl}/api/usage/projects/p1`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.projectSlug).toBe('p1');
    expect(body.daily.length).toBe(2);
    expect(body.summary.length).toBe(2);
    expect(body.summary.every((s: { projectSlug: string }) => s.projectSlug === 'p1')).toBe(true);
  });

  it('includes an assignment that has only a snapshot window (A-then-B cumulative row)', async () => {
    // The TRUE failure shape: one session worked A then B on the same model, but
    // the cumulative usage_events row attributes only to B (the latest). A has a
    // real closed engagement window yet NO usage_daily row — it must still appear.
    seed('p1', 'B', 400, 4.0); // single cumulative row, attributed to B only
    runRollup();
    seedWindow('p1', 'A', 1.5);
    seedWindow('p1', 'B', 2.5);

    const res = await fetch(`${baseUrl}/api/usage/projects/p1`);
    expect(res.status).toBe(200);
    const body = await res.json();
    const cost = Object.fromEntries(
      body.summary.map((s: { assignmentSlug: string; totalCost: number }) => [s.assignmentSlug, s.totalCost]),
    );
    // A is present (snapshot window) despite having no usage_daily row.
    expect(body.summary.some((s: { assignmentSlug: string }) => s.assignmentSlug === 'A')).toBe(true);
    expect(cost.A).toBeCloseTo(1.5, 6);
    // B's cost is its WINDOW delta (2.5), NOT the whole cumulative row (4.0).
    expect(cost.B).toBeCloseTo(2.5, 6);
  });

  it('surfaces zeroed confidence counts for a project-rollup assignment with no closed window', async () => {
    // a1 has usage_daily but NO engagement window — it must still carry the
    // window-confidence count fields (all 0), not omit them.
    seed('p1', 'a1', 100, 0.5);
    runRollup();

    const res = await fetch(`${baseUrl}/api/usage/projects/p1`);
    const body = await res.json();
    const a1 = body.summary.find((s: { assignmentSlug: string }) => s.assignmentSlug === 'a1');
    expect(a1).toBeDefined();
    expect(a1.totalCost).toBe(0); // snapshot-derived: no closed window yet
    expect(a1.pricedWindowCount).toBe(0);
    expect(a1.uncomputableWindowCount).toBe(0);
    expect(a1.negativeDeltaCount).toBe(0);
  });

  it('surfaces snapshot-window confidence counts on the per-assignment summary', async () => {
    seed('p1', 'a1', 100, 0.5);
    runRollup();
    seedWindow('p1', 'a1', 0.5);

    const res = await fetch(`${baseUrl}/api/usage/projects/p1/assignments/a1`);
    const body = await res.json();
    expect(body.summary.pricedWindowCount).toBe(1);
    expect(body.summary.uncomputableWindowCount).toBe(0);
    expect(body.summary.negativeDeltaCount).toBe(0);
  });
});

describe('GET /api/usage/projects/:projectSlug/assignments/:assignmentSlug', () => {
  it('returns daily + events for a specific assignment', async () => {
    seed('p1', 'a1', 100, 0.5);
    seed('p1', 'a2', 200, 1.0);
    runRollup();

    const res = await fetch(`${baseUrl}/api/usage/projects/p1/assignments/a1`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.projectSlug).toBe('p1');
    expect(body.assignmentSlug).toBe('a1');
    expect(body.daily.length).toBe(1);
    expect(body.events.length).toBe(1);
    expect(body.events[0].total_tokens).toBe(100);
  });

  it('includes a pre-aggregated summary for the assignment', async () => {
    seed('p1', 'a1', 100, 0.5);
    seed('p1', 'a2', 200, 1.0);
    runRollup();
    // M2: per-assignment cost is the snapshot-window delta, not the cumulative row.
    seedWindow('p1', 'a1', 0.5);

    const res = await fetch(`${baseUrl}/api/usage/projects/p1/assignments/a1`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.summary.totalTokens).toBe(100);
    expect(body.summary.totalCost).toBe(0.5);
    expect(body.summary.lastEventDay).toBe('2026-05-21');
    expect(body.summary.byModel).toEqual([
      { model: 'claude-opus-4-7', totalTokens: 100, totalCost: 0.5 },
    ]);
  });

  it('merges byModel across multiple days and models, ordered by tokens desc', async () => {
    // One assignment, two models, spread across two days.
    seed('p1', 'merge', 100, 0.5, '2026-05-20T12:00:00.000Z', 'claude-opus-4-7');
    seed('p1', 'merge', 30, 0.25, '2026-05-21T12:00:00.000Z', 'claude-opus-4-7');
    seed('p1', 'merge', 50, 0.125, '2026-05-21T12:00:00.000Z', 'claude-sonnet-4-6');
    runRollup();
    // M2: headline cost is the snapshot-window total (here matching the cumulative);
    // byModel keeps the usage_daily per-model breakdown.
    seedWindow('p1', 'merge', 0.875);

    const res = await fetch(`${baseUrl}/api/usage/projects/p1/assignments/merge`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.summary.totalTokens).toBe(180);
    expect(body.summary.totalCost).toBeCloseTo(0.875, 6);
    expect(body.summary.lastEventDay).toBe('2026-05-21');
    // opus (130) before sonnet (50); the two opus daily rows are merged.
    expect(body.summary.byModel).toEqual([
      { model: 'claude-opus-4-7', totalTokens: 130, totalCost: 0.75 },
      { model: 'claude-sonnet-4-6', totalTokens: 50, totalCost: 0.125 },
    ]);
  });

  it('reconciles the header total with the by-model breakdown when there is NO engagement window', async () => {
    // The photographed bug: an assignment accrues usage_daily cost (attributed by
    // slug) yet never had a registered agent session, so there are ZERO closed
    // engagement windows. The window-derived header must NOT show $0 over a
    // non-zero per-model breakdown — with no window to attribute, it falls back to
    // the cumulative daily cost, which is exactly what `byModel` sums to.
    seed('p1', 'nowin', 100, 0.5, '2026-05-21T12:00:00.000Z', 'claude-opus-4-7');
    seed('p1', 'nowin', 50, 0.125, '2026-05-21T12:00:00.000Z', 'claude-sonnet-4-6');
    runRollup();
    // NOTE: no seedWindow() — this assignment has no engagement window at all.

    const res = await fetch(`${baseUrl}/api/usage/projects/p1/assignments/nowin`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.summary.pricedWindowCount).toBe(0); // confirms the no-window path
    const byModelSum = body.summary.byModel.reduce(
      (acc: number, m: { totalCost: number }) => acc + m.totalCost,
      0,
    );
    expect(byModelSum).toBeCloseTo(0.625, 6);
    // Header reconciles with its own breakdown instead of showing $0.00 over $0.625.
    expect(body.summary.totalCost).toBeCloseTo(byModelSum, 6);
    expect(body.summary.totalCost).toBeCloseTo(0.625, 6);
  });

  it('returns a calm zero summary when the assignment has no usage', async () => {
    seed('p1', 'a1', 100, 0.5);
    runRollup();

    const res = await fetch(`${baseUrl}/api/usage/projects/p1/assignments/none`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.daily.length).toBe(0);
    expect(body.events.length).toBe(0);
    expect(body.summary.totalTokens).toBe(0);
    expect(body.summary.totalCost).toBe(0);
    expect(body.summary.lastEventDay).toBeNull();
    expect(body.summary.byModel).toEqual([]);
  });
});

describe('GET /api/usage/standalone/:assignmentId', () => {
  it('treats project_slug as empty for standalone assignments', async () => {
    seed('', 'standalone-asgn', 500, 0.7);
    runRollup();
    // Standalone window stored with project_slug NULL; reader maps ''→NULL.
    seedWindow('', 'standalone-asgn', 0.7);

    const res = await fetch(`${baseUrl}/api/usage/standalone/standalone-asgn`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.assignmentId).toBe('standalone-asgn');
    expect(body.daily.length).toBe(1);
    expect(body.events.length).toBe(1);
    expect(body.summary.totalTokens).toBe(500);
    expect(body.summary.totalCost).toBe(0.7);
    expect(body.summary.byModel).toEqual([
      { model: 'claude-opus-4-7', totalTokens: 500, totalCost: 0.7 },
    ]);
  });

  it('returns a calm zero summary for a standalone assignment with no usage', async () => {
    seed('', 'standalone-asgn', 500, 0.7);
    runRollup();

    const res = await fetch(`${baseUrl}/api/usage/standalone/none`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.daily.length).toBe(0);
    expect(body.events.length).toBe(0);
    expect(body.summary.totalTokens).toBe(0);
    expect(body.summary.totalCost).toBe(0);
    expect(body.summary.lastEventDay).toBeNull();
    expect(body.summary.byModel).toEqual([]);
  });
});

describe('GET /api/usage?model=', () => {
  it('narrows daily rows to a single model', async () => {
    seed('p', 'a', 100, 0.5, '2026-05-21T12:00:00.000Z', 'claude-opus-4-7');
    seed('p', 'a', 200, 1.0, '2026-05-21T12:00:00.000Z', 'claude-sonnet-4-6');
    runRollup();

    const res = await fetch(`${baseUrl}/api/usage?model=claude-sonnet-4-6`);
    const body = await res.json();
    expect(body.daily.length).toBe(1);
    expect(body.daily[0].model).toBe('claude-sonnet-4-6');
  });
});

describe('GET /api/usage/facets', () => {
  it('returns distinct sorted models and tools', async () => {
    seed('p', 'a', 100, 0.5, '2026-05-21T12:00:00.000Z', 'claude-sonnet-4-6');
    seed('p', 'a', 200, 1.0, '2026-05-20T12:00:00.000Z', 'claude-opus-4-7');
    runRollup();

    const res = await fetch(`${baseUrl}/api/usage/facets`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.models).toEqual(['claude-opus-4-7', 'claude-sonnet-4-6']);
    expect(body.tools).toEqual(['claude']);
  });
});

describe('GET /api/usage?workspace=', () => {
  it('unions member projects + standalones, excludes others and unattributed', async () => {
    await writeProject('p1', 'backend');
    await writeProject('p2', null);
    await writeStandalone('s1', 'backend');
    await writeStandalone('s2', null);
    seed('p1', 'a1', 100, 0.5); // member (project)
    seed('p2', 'a1', 200, 1.0); // other project
    seed('', 's1', 300, 1.5); // member (standalone)
    seed('', 's2', 400, 2.0); // other standalone
    seed('', '', 999, 9.9); // unattributed
    runRollup();

    const res = await fetch(`${baseUrl}/api/usage?workspace=backend`);
    expect(res.status).toBe(200);
    const body = await res.json();
    const tokens = body.daily.reduce((acc: number, r: { total_tokens: number }) => acc + r.total_tokens, 0);
    expect(tokens).toBe(400); // 100 (p1) + 300 (s1) only
    expect(body.daily.some((r: { project_slug: string }) => r.project_slug === 'p2')).toBe(false);
    expect(
      body.daily.some((r: { project_slug: string; assignment_slug: string }) =>
        r.project_slug === '' && r.assignment_slug === '',
      ),
    ).toBe(false);
  });

  it('_ungrouped selects null-workspace projects + null-group standalones', async () => {
    await writeProject('p1', 'backend');
    await writeProject('p2', null);
    await writeStandalone('s2', null);
    seed('p1', 'a1', 100, 0.5);
    seed('p2', 'a1', 200, 1.0);
    seed('', 's2', 400, 2.0);
    runRollup();

    const res = await fetch(`${baseUrl}/api/usage?workspace=_ungrouped`);
    const body = await res.json();
    const tokens = body.daily.reduce((acc: number, r: { total_tokens: number }) => acc + r.total_tokens, 0);
    expect(tokens).toBe(600); // p2 (200) + s2 (400)
  });

  it('rejects project + workspace together with 400', async () => {
    const res = await fetch(`${baseUrl}/api/usage?workspace=backend&project=p1`);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/not both/);
  });
});
