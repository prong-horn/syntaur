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
import { createUsageRouter, getTicketUsageHandler } from '../dashboard/api-usage.js';

let sandbox: string;
let projectsDir: string;
let server: ReturnType<typeof express>['listen'] extends (port: number) => infer T ? T : never;
let baseUrl: string;
let originalEnv: string | undefined;

/** Write a minimal project.md so listProjects can see it. */
async function writeProject(slug: string): Promise<void> {
  const dir = resolve(projectsDir, slug);
  await mkdir(dir, { recursive: true });
  await writeFile(
    resolve(dir, 'project.md'),
    `---\nslug: ${slug}\ntitle: ${slug}\ncreated: "2026-05-01"\nupdated: "2026-05-01"\n---\n\n# ${slug}\n`,
    'utf-8',
  );
}

/** Write a project-nested ticket.md with an explicit id for id-based routes. */
async function writeProjectTicket(
  projectSlug: string,
  ticketSlug: string,
  ticketId: string,
): Promise<void> {
  await writeProject(projectSlug);
  const dir = resolve(projectsDir, projectSlug, 'tickets', `${ticketId}-${ticketSlug}`);
  await mkdir(dir, { recursive: true });
  await writeFile(
    resolve(dir, 'ticket.md'),
    `---\nid: ${ticketId}\nslug: ${ticketSlug}\ntitle: ${ticketSlug}\nstatus: pending\npriority: medium\ncreated: "2026-05-01T00:00:00Z"\nupdated: "2026-05-01T00:00:00Z"\narchived: false\ntags: []\n---\n\n# ${ticketSlug}\n`,
    'utf-8',
  );
}

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'syntaur-api-usage-'));
  projectsDir = resolve(sandbox, 'projects');
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
  app.use('/api/usage', createUsageRouter(projectsDir));
  app.get('/api/tickets/:id/usage', getTicketUsageHandler(projectsDir));

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
 * per-ticket cost. open cost 0 → close cost `costDelta`, so the window cost
 * equals `costDelta`. Standalone (`projectSlug === ''`) stores `project_slug NULL`.
 */
function ticketIdForSlug(slug: string): string {
  const num = slug.match(/(\d+)$/)?.[1] ?? '1';
  const letters = slug.replace(/[^a-z]/gi, '').toUpperCase().padEnd(2, 'X').slice(0, 3);
  return `${letters}-${num}`;
}

function seedWindow(
  projectSlug: string,
  ticketId: string,
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
    sessionId: `win-${projectSlug}-${ticketId}-${model}-${endedAt}`,
    ticketId,
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
  ticketSlug: string,
  totalTokens: number,
  totalCost: number,
  eventTs = '2026-05-21T12:00:00.000Z',
  model = 'claude-opus-4-7',
  ticketId?: string,
) {
  const id = ticketId ?? ticketIdForSlug(ticketSlug);
  upsertEvent({
    sessionId: `${projectSlug}-${id}-${model}-${eventTs}`,
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
    ticketSlug: id,
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
  it('restricts to a single project and groups by ticket', async () => {
    // Ticket ids are globally unique; the project scope is its CURRENT tickets.
    await writeProjectTicket('p1', 'a1', 'PA-1');
    await writeProjectTicket('p1', 'a2', 'PA-2');
    await writeProjectTicket('p2', 'b1', 'PB-1');
    seed('p1', 'a1', 100, 0.5, undefined, undefined, 'PA-1');
    seed('p1', 'a2', 200, 1.0, undefined, undefined, 'PA-2');
    seed('p2', 'b1', 300, 2.0, undefined, undefined, 'PB-1');
    runRollup();

    const res = await fetch(`${baseUrl}/api/usage/projects/p1`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.projectSlug).toBe('p1');
    expect(body.daily.length).toBe(2);
    expect(body.summary.length).toBe(2);
    expect(body.summary.every((s: { projectSlug: string }) => s.projectSlug === 'p1')).toBe(true);
  });

  it('includes a ticket that has only a snapshot window (A-then-B cumulative row)', async () => {
    const idA = 'USA-1';
    const idB = 'USB-1';
    await writeProjectTicket('p1', 'A', idA);
    await writeProjectTicket('p1', 'B', idB);
    seed('p1', 'B', 400, 4.0, undefined, undefined, idB);
    runRollup();
    seedWindow('p1', idA, 1.5);
    seedWindow('p1', idB, 2.5);

    const res = await fetch(`${baseUrl}/api/usage/projects/p1`);
    expect(res.status).toBe(200);
    const body = await res.json();
    const cost = Object.fromEntries(
      body.summary.map((s: { ticketSlug: string; totalCost: number }) => [s.ticketSlug, s.totalCost]),
    );
    expect(body.summary.some((s: { ticketSlug: string }) => s.ticketSlug === idA)).toBe(true);
    expect(cost[idA]).toBeCloseTo(1.5, 6);
    expect(cost[idB]).toBeCloseTo(2.5, 6);
  });

  it('falls back to usage_daily cost (costSource usage) with zeroed counts for a rollup ticket with no closed window', async () => {
    // a1 has usage_daily but NO engagement window — it must still carry the
    // window-confidence count fields (all 0), and its attributed cost is NOT
    // silently zeroed: it falls back to the windowed daily cost, labelled.
    const ticketId = ticketIdForSlug('a1');
    await writeProjectTicket('p1', 'a1', ticketId);
    seed('p1', 'a1', 100, 0.5, undefined, undefined, ticketId);
    runRollup();

    const res = await fetch(`${baseUrl}/api/usage/projects/p1`);
    const body = await res.json();
    const a1 = body.summary.find((s: { ticketSlug: string }) => s.ticketSlug === ticketId);
    expect(a1).toBeDefined();
    expect(a1.totalCost).toBe(0.5);
    expect(a1.costSource).toBe('usage');
    expect(a1.pricedWindowCount).toBe(0);
    expect(a1.uncomputableWindowCount).toBe(0);
    expect(a1.negativeDeltaCount).toBe(0);
  });

  it('surfaces snapshot-window confidence counts on the per-ticket summary', async () => {
    const ticketId = 'USG-1';
    await writeProjectTicket('p1', 'a1', ticketId);
    seed('p1', 'a1', 100, 0.5, undefined, undefined, ticketId);
    runRollup();
    seedWindow('p1', ticketId, 0.5);

    const res = await fetch(`${baseUrl}/api/tickets/${ticketId}/usage`);
    const body = await res.json();
    expect(body.summary.pricedWindowCount).toBe(1);
    expect(body.summary.uncomputableWindowCount).toBe(0);
    expect(body.summary.negativeDeltaCount).toBe(0);
  });
});

describe('GET /api/tickets/:id/usage', () => {
  it('returns daily + events for a specific ticket', async () => {
    const ticketId = 'USG-1';
    await writeProjectTicket('p1', 'a1', ticketId);
    seed('p1', 'a1', 100, 0.5, undefined, undefined, ticketId);
    seed('p1', 'a2', 200, 1.0);
    runRollup();

    const res = await fetch(`${baseUrl}/api/tickets/${ticketId}/usage`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.projectSlug).toBe('p1');
    expect(body.ticketSlug).toBe('a1');
    expect(body.daily.length).toBe(1);
    expect(body.events.length).toBe(1);
    expect(body.events[0].total_tokens).toBe(100);
  });

  it('includes a pre-aggregated summary for the ticket', async () => {
    const ticketId = 'USG-1';
    await writeProjectTicket('p1', 'a1', ticketId);
    seed('p1', 'a1', 100, 0.5, undefined, undefined, ticketId);
    seed('p1', 'a2', 200, 1.0);
    runRollup();
    // M2: per-ticket cost is the snapshot-window delta, not the cumulative row.
    seedWindow('p1', ticketId, 0.5);

    const res = await fetch(`${baseUrl}/api/tickets/${ticketId}/usage`);
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
    const ticketId = 'USG-2';
    await writeProjectTicket('p1', 'merge', ticketId);
    // One ticket, two models, spread across two days.
    seed('p1', 'merge', 100, 0.5, '2026-05-20T12:00:00.000Z', 'claude-opus-4-7', ticketId);
    seed('p1', 'merge', 30, 0.25, '2026-05-21T12:00:00.000Z', 'claude-opus-4-7', ticketId);
    seed('p1', 'merge', 50, 0.125, '2026-05-21T12:00:00.000Z', 'claude-sonnet-4-6', ticketId);
    runRollup();
    // M2: headline cost is the snapshot-window total (here matching the cumulative);
    // byModel keeps the usage_daily per-model breakdown.
    seedWindow('p1', ticketId, 0.875);

    const res = await fetch(`${baseUrl}/api/tickets/${ticketId}/usage`);
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
    const ticketId = 'USG-3';
    await writeProjectTicket('p1', 'nowin', ticketId);
    // The photographed bug: a ticket accrues usage_daily cost (attributed by
    // slug) yet never had a registered agent session, so there are ZERO closed
    // engagement windows. The window-derived header must NOT show $0 over a
    // non-zero per-model breakdown — with no window to attribute, it falls back to
    // the cumulative daily cost, which is exactly what `byModel` sums to.
    seed('p1', 'nowin', 100, 0.5, '2026-05-21T12:00:00.000Z', 'claude-opus-4-7', ticketId);
    seed('p1', 'nowin', 50, 0.125, '2026-05-21T12:00:00.000Z', 'claude-sonnet-4-6', ticketId);
    runRollup();
    // NOTE: no seedWindow() — this ticket has no engagement window at all.

    const res = await fetch(`${baseUrl}/api/tickets/${ticketId}/usage`);
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

  it('returns a calm zero summary when the ticket has no usage', async () => {
    const ticketId = 'USG-4';
    await writeProjectTicket('p1', 'none', ticketId);
    seed('p1', 'a1', 100, 0.5);
    runRollup();

    const res = await fetch(`${baseUrl}/api/tickets/${ticketId}/usage`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.daily.length).toBe(0);
    expect(body.events.length).toBe(0);
    expect(body.summary.totalTokens).toBe(0);
    expect(body.summary.totalCost).toBe(0);
    expect(body.summary.lastEventDay).toBeNull();
    expect(body.summary.byModel).toEqual([]);
  });
  it('returns usage for a project-nested ticket resolved by id', async () => {
    const ticketId = 'STL-1';
    await writeProjectTicket('p1', 'standalone-asgn', ticketId);
    seed('p1', 'standalone-asgn', 500, 0.7, undefined, undefined, ticketId);
    runRollup();
    seedWindow('p1', ticketId, 0.7);

    const res = await fetch(`${baseUrl}/api/tickets/${ticketId}/usage`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ticketId).toBe(ticketId);
    expect(body.daily.length).toBe(1);
    expect(body.events.length).toBe(1);
    expect(body.summary.totalTokens).toBe(500);
    expect(body.summary.totalCost).toBe(0.7);
    expect(body.summary.byModel).toEqual([
      { model: 'claude-opus-4-7', totalTokens: 500, totalCost: 0.7 },
    ]);
  });

  it('returns a calm zero summary for a ticket with no usage', async () => {
    const ticketId = 'STL-2';
    await writeProjectTicket('p1', 'standalone-none', ticketId);
    seed('p1', 'standalone-asgn', 500, 0.7);
    runRollup();

    const res = await fetch(`${baseUrl}/api/tickets/${ticketId}/usage`);
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

/** A CLOSED window with no snapshots (uncomputable — contributes 0, counted). */
function seedUncomputableWindow(ticketId: string, sessionId: string): void {
  const startedAt = '2026-05-21T09:00:00.000Z';
  const row = openEngagement({ sessionId, ticketId, stage: 'implement', startedAt });
  closeEngagementById({
    id: row.id,
    startedAt,
    closeReason: 'switch',
    endedAt: '2026-05-21T10:00:00.000Z',
  });
}

describe('SV-12 ticket usage — ticket-id attribution and lifetime alignment', () => {
  it('includes rows whose attribution left project_slug empty (no undercount)', async () => {
    const ticketId = 'EMP-1';
    await writeProjectTicket('p1', 'emp', ticketId);
    seed('p1', 'emp', 100, 0.5, '2026-05-20T12:00:00.000Z', undefined, ticketId);
    seed('', 'emp', 40, 0.25, '2026-05-21T12:00:00.000Z', undefined, ticketId);
    seed('p1', 'other', 999, 9, undefined, undefined, 'OTH-9');
    runRollup();

    const res = await fetch(`${baseUrl}/api/tickets/${ticketId}/usage`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.daily.length).toBe(2);
    expect(body.events.length).toBe(2);
    expect(body.summary.totalTokens).toBe(140);
    expect(body.summary.totalCost).toBeCloseTo(0.75, 9);
    expect(body.summary.costSource).toBe('usage');
    // Lifetime block = the card/header helper, identical when unfiltered.
    expect(body.summary.lifetime).toEqual({
      costUsd: 0.75,
      sessionCount: 0,
      costSource: 'usage',
      partial: false,
    });
  });

  it('a ?since window narrows totalCost but NOT the lifetime block', async () => {
    const ticketId = 'WIN-1';
    await writeProjectTicket('p1', 'win', ticketId);
    seed('p1', 'win', 100, 0.5, '2026-05-19T12:00:00.000Z', undefined, ticketId);
    seed('', 'win', 40, 0.25, '2026-05-21T12:00:00.000Z', undefined, ticketId);
    runRollup();

    const res = await fetch(`${baseUrl}/api/tickets/${ticketId}/usage?since=2026-05-20`);
    const body = await res.json();
    expect(body.daily.length).toBe(1);
    expect(body.summary.totalCost).toBeCloseTo(0.25, 9);
    expect(body.summary.lifetime.costUsd).toBeCloseTo(0.75, 9);
  });

  it('engagement-sourced summary: window cost, never added to the event sum; partial from uncomputable window', async () => {
    const ticketId = 'ENG-7';
    await writeProjectTicket('p1', 'eng', ticketId);
    seed('p1', 'eng', 100, 5, undefined, undefined, ticketId);
    runRollup();
    seedWindow('p1', ticketId, 1.25);
    seedUncomputableWindow(ticketId, 'unc-session');

    const body = await (await fetch(`${baseUrl}/api/tickets/${ticketId}/usage`)).json();
    expect(body.summary.costSource).toBe('engagement');
    expect(body.summary.totalCost).toBeCloseTo(1.25, 9);
    expect(body.summary.uncomputableWindowCount).toBe(1);
    expect(body.summary.lifetime).toEqual({
      costUsd: 1.25,
      sessionCount: 2,
      costSource: 'engagement',
      partial: true,
    });
  });

  it('no usage at all → costSource none, lifetime cost unknown (null)', async () => {
    const ticketId = 'NIL-1';
    await writeProjectTicket('p1', 'nil', ticketId);
    const body = await (await fetch(`${baseUrl}/api/tickets/${ticketId}/usage`)).json();
    expect(body.summary.totalCost).toBe(0);
    expect(body.summary.costSource).toBe('none');
    expect(body.summary.lifetime).toEqual({
      costUsd: null,
      sessionCount: 0,
      costSource: 'none',
      partial: false,
    });
  });
});

describe('SV-12 usage rollups — project scope by ticket id', () => {
  async function seedScopeFixture(): Promise<void> {
    await writeProjectTicket('p1', 'one', 'SCP-1');
    await writeProjectTicket('p1', 'two', 'SCP-2');
    await writeProjectTicket('p2', 'three', 'SCP-3');
    // SCP-1: one slugged row + one empty-slug row (attribution left it empty).
    seed('p1', 'one', 100, 1.0, '2026-05-20T12:00:00.000Z', undefined, 'SCP-1');
    seed('', 'one', 50, 0.5, '2026-05-21T12:00:00.000Z', undefined, 'SCP-1');
    // SCP-2: slugged row only.
    seed('p1', 'two', 30, 0.3, '2026-05-21T12:00:00.000Z', undefined, 'SCP-2');
    // Genuine project-only row (project slug, no ticket).
    upsertEvent({
      sessionId: 'proj-only',
      model: 'claude-opus-4-7',
      tool: 'claude',
      eventTs: '2026-05-21T12:00:00.000Z',
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      totalTokens: 7,
      totalCost: 0.07,
      cwd: null,
      projectSlug: 'p1',
      ticketSlug: '',
      rawJson: null,
    });
    // Another project's ticket, and a fully unattributed row: both excluded.
    seed('p2', 'three', 1000, 10, '2026-05-21T12:00:00.000Z', undefined, 'SCP-3');
    seed('', 'x', 2000, 20, '2026-05-21T12:00:00.000Z', undefined, '');
    runRollup();
  }

  it('/api/usage?project= counts member-ticket rows with empty slug and project-only rows exactly once', async () => {
    await seedScopeFixture();
    const body = await (await fetch(`${baseUrl}/api/usage?project=p1`)).json();
    expect(body.costBasis).toBe('usage-daily');
    expect(body.summary).toHaveLength(1);
    expect(body.summary[0].projectSlug).toBe('p1');
    expect(body.summary[0].totalTokens).toBe(100 + 50 + 30 + 7);
    expect(body.summary[0].totalCost).toBeCloseTo(1.87, 9);
  });

  it('/api/usage?project=&groupBy=ticket merges a ticket split across empty/real slugs into one row', async () => {
    await seedScopeFixture();
    const body = await (await fetch(`${baseUrl}/api/usage?project=p1&groupBy=ticket`)).json();
    const byTicket = Object.fromEntries(
      body.summary.map((r: { ticketSlug: string; totalCost: number; projectSlug: string }) => [
        r.ticketSlug,
        r,
      ]),
    );
    expect(Object.keys(byTicket).sort()).toEqual(['', 'SCP-1', 'SCP-2']);
    expect(byTicket['SCP-1'].totalCost).toBeCloseTo(1.5, 9);
    expect(byTicket['SCP-1'].projectSlug).toBe('p1');
    expect(byTicket[''].totalCost).toBeCloseTo(0.07, 9);
  });

  it('unfiltered groupBy=ticket also merges split rows; groupBy=project semantics unchanged', async () => {
    await seedScopeFixture();
    const tickets = await (await fetch(`${baseUrl}/api/usage?groupBy=ticket`)).json();
    const scp1 = tickets.summary.filter((r: { ticketSlug: string }) => r.ticketSlug === 'SCP-1');
    expect(scp1).toHaveLength(1);
    expect(scp1[0].projectSlug).toBe('p1');
    expect(scp1[0].totalCost).toBeCloseTo(1.5, 9);

    const projects = await (await fetch(`${baseUrl}/api/usage`)).json();
    const slugs = projects.summary.map((r: { projectSlug: string }) => r.projectSlug).sort();
    // Without a project filter the per-project grouping stays by recorded slug.
    expect(slugs).toEqual(['', 'p1', 'p2']);
  });

  it('project scope preserves the since/until window filter', async () => {
    await seedScopeFixture();
    const body = await (await fetch(`${baseUrl}/api/usage?project=p1&since=2026-05-21`)).json();
    // The 2026-05-20 SCP-1 row falls outside the window.
    expect(body.summary[0].totalTokens).toBe(50 + 30 + 7);
    expect(body.daily.every((d: { day: string }) => d.day >= '2026-05-21')).toBe(true);
  });

  it('/api/usage/projects/:slug: window-first per ticket, labelled, mixed complete/incomplete windows', async () => {
    await seedScopeFixture();
    // SCP-1: priced window 0.9 + an uncomputable one → engagement (not + daily).
    seedWindow('p1', 'SCP-1', 0.9);
    seedUncomputableWindow('SCP-1', 'scp1-unc');
    // SCP-2: only an uncomputable window → falls back to its windowed daily cost.
    seedUncomputableWindow('SCP-2', 'scp2-unc');

    const body = await (await fetch(`${baseUrl}/api/usage/projects/p1`)).json();
    expect(body.costBasis).toBe('window-first');
    const rows = Object.fromEntries(
      body.summary.map((r: { ticketSlug: string }) => [r.ticketSlug, r]),
    );
    expect(Object.keys(rows).sort()).toEqual(['', 'SCP-1', 'SCP-2']);
    expect(rows['SCP-1']).toMatchObject({
      totalTokens: 150,
      costSource: 'engagement',
      pricedWindowCount: 1,
      uncomputableWindowCount: 1,
    });
    expect(rows['SCP-1'].totalCost).toBeCloseTo(0.9, 9);
    expect(rows['SCP-2']).toMatchObject({ costSource: 'usage', uncomputableWindowCount: 1 });
    expect(rows['SCP-2'].totalCost).toBeCloseTo(0.3, 9);
    expect(rows[''].costSource).toBe('usage');
    expect(rows[''].totalCost).toBeCloseTo(0.07, 9);
    // Daily rows: SCP-1 ×2, SCP-2, project-only — p2 and unattributed excluded.
    expect(body.daily).toHaveLength(4);
  });
});
