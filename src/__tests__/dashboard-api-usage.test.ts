import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import {
  initUsageDb,
  closeUsageDb,
  resetUsageDb,
  upsertEvent,
} from '../db/usage-db.js';
import { runRollup } from '../usage/rollup-runner.js';
import { createUsageRouter } from '../dashboard/api-usage.js';

let sandbox: string;
let server: ReturnType<typeof express>['listen'] extends (port: number) => infer T ? T : never;
let baseUrl: string;
let originalEnv: string | undefined;

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'syntaur-api-usage-'));
  originalEnv = process.env.SYNTAUR_HOME;
  process.env.SYNTAUR_HOME = sandbox;
  resetUsageDb();
  initUsageDb();

  const app = express();
  app.use('/api/usage', createUsageRouter());

  await new Promise<void>((res) => {
    server = app.listen(0, '127.0.0.1', () => res());
  });
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterEach(async () => {
  await new Promise<void>((res) => server.close(() => res()));
  closeUsageDb();
  if (originalEnv === undefined) delete process.env.SYNTAUR_HOME;
  else process.env.SYNTAUR_HOME = originalEnv;
  await rm(sandbox, { recursive: true, force: true });
});

function seed(
  projectSlug: string,
  assignmentSlug: string,
  totalTokens: number,
  totalCost: number,
  eventTs = '2026-05-21T12:00:00.000Z',
) {
  upsertEvent({
    sessionId: `${projectSlug}-${assignmentSlug}`,
    model: 'claude-opus-4-7',
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
    expect(body.summary.lastEventDay).toBeNull();
    expect(body.summary.byModel).toEqual([]);
  });
});
