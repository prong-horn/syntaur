import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import { initUsageDb, closeUsageDb, resetUsageDb, upsertEvent } from '../db/usage-db.js';
import { initSessionDb, closeSessionDb, resetSessionDb } from '../dashboard/session-db.js';
import { appendSession } from '../dashboard/agent-sessions.js';
import { createAgentSessionsRouter } from '../dashboard/api-agent-sessions.js';
import type { AgentSessionWithLiveness } from '../dashboard/types.js';

let sandbox: string;
let projectsDir: string;
let server: ReturnType<express.Express['listen']>;
let baseUrl: string;
let originalEnv: string | undefined;

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'syntaur-sessions-usage-'));
  projectsDir = resolve(sandbox, 'projects');
  await mkdir(projectsDir, { recursive: true });
  originalEnv = process.env.SYNTAUR_HOME;
  process.env.SYNTAUR_HOME = sandbox;
  resetUsageDb();
  resetSessionDb();
  // Both modules open the SAME syntaur.db file under SYNTAUR_HOME.
  initSessionDb();
  initUsageDb();

  const app = express();
  app.use(express.json());
  app.use('/api/agent-sessions', createAgentSessionsRouter(projectsDir));
  await new Promise<void>((res) => {
    server = app.listen(0, '127.0.0.1', () => res());
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((res) => server.close(() => res()));
  closeUsageDb();
  closeSessionDb();
  if (originalEnv === undefined) delete process.env.SYNTAUR_HOME;
  else process.env.SYNTAUR_HOME = originalEnv;
  await rm(sandbox, { recursive: true, force: true });
});

async function seedSession(sessionId: string, overrides: Record<string, unknown> = {}): Promise<void> {
  await appendSession('', {
    projectSlug: null,
    assignmentSlug: null,
    agent: 'claude',
    sessionId,
    started: '2026-07-01T10:00:00.000Z',
    status: 'stopped',
    path: '/Users/test/repo',
    ...overrides,
  } as Parameters<typeof appendSession>[1]);
}

function seedUsage(
  sessionId: string,
  opts: {
    model: string;
    tool?: string;
    cost: number;
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    cwd?: string | null;
    eventTs?: string;
  },
): void {
  upsertEvent({
    sessionId,
    model: opts.model,
    tool: opts.tool ?? 'claude',
    eventTs: opts.eventTs ?? '2026-07-01T11:00:00.000Z',
    inputTokens: opts.inputTokens ?? 0,
    outputTokens: opts.outputTokens ?? 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    totalTokens: opts.totalTokens ?? (opts.inputTokens ?? 0) + (opts.outputTokens ?? 0),
    totalCost: opts.cost,
    // `??` would swallow an explicit null, which some cases need to assert.
    cwd: 'cwd' in opts ? opts.cwd ?? null : '/Users/test/repo',
    projectSlug: '',
    assignmentSlug: '',
    rawJson: null,
  });
}

async function getSessions(query = ''): Promise<AgentSessionWithLiveness[]> {
  const res = await fetch(`${baseUrl}/api/agent-sessions${query}`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { sessions: AgentSessionWithLiveness[] };
  return body.sessions;
}

describe('GET /api/agent-sessions usage enrichment', () => {
  it('attaches per-session cost and tokens from usage_events', async () => {
    await seedSession('s-priced');
    seedUsage('s-priced', { model: 'claude-opus-4-8', cost: 1.25, totalTokens: 5000 });

    const [session] = await getSessions();
    expect(session.sessionId).toBe('s-priced');
    expect(session.usage?.totalCost).toBeCloseTo(1.25, 6);
    expect(session.usage?.totalTokens).toBe(5000);
    expect(session.usage?.models).toEqual([
      { model: 'claude-opus-4-8', cost: 1.25, tokens: 5000 },
    ]);
  });

  it('applies the token×rate fallback to historical $0 rows at serve time', async () => {
    await seedSession('s-pi');
    // A pi row as ccusage records it: real tokens, zero cost (no bundled price).
    seedUsage('s-pi', {
      model: '[pi] hf:zai-org/GLM-5.2',
      tool: 'pi',
      cost: 0,
      inputTokens: 1_000_000,
      outputTokens: 0,
      totalTokens: 1_000_000,
    });

    const [session] = await getSessions();
    // 1M input tokens at the GLM-5.2 list input rate of $1.40/M.
    expect(session.usage?.totalCost).toBeCloseTo(1.4, 6);
    expect(session.usage?.models[0].cost).toBeCloseTo(1.4, 6);
  });

  it('leaves an unpriced model at zero rather than guessing', async () => {
    await seedSession('s-unknown');
    seedUsage('s-unknown', {
      model: '[pi] syn:large:text',
      tool: 'pi',
      cost: 0,
      inputTokens: 500_000,
      totalTokens: 500_000,
    });

    const [session] = await getSessions();
    expect(session.usage?.totalCost).toBe(0);
    expect(session.usage?.totalTokens).toBe(500_000);
  });

  it('reports usage: null for a session the collector never saw', async () => {
    await seedSession('s-no-usage');
    const [session] = await getSessions();
    expect(session.usage).toBeNull();
  });

  it('sums multiple models within one session', async () => {
    await seedSession('s-multi');
    seedUsage('s-multi', { model: 'claude-opus-4-8', cost: 2, totalTokens: 100 });
    seedUsage('s-multi', { model: 'claude-haiku-4-5', cost: 0.5, totalTokens: 40 });

    const [session] = await getSessions();
    expect(session.usage?.totalCost).toBeCloseTo(2.5, 6);
    expect(session.usage?.totalTokens).toBe(140);
    expect(session.usage?.models).toHaveLength(2);
  });
});

describe('usage-only (orphan) rows', () => {
  it('are absent without includeUsageOnly=1', async () => {
    await seedSession('s-tracked');
    seedUsage('s-tracked', { model: 'claude-opus-4-8', cost: 1, totalTokens: 10 });
    seedUsage('s-orphan', { model: 'claude-opus-4-8', cost: 3, totalTokens: 30 });

    const sessions = await getSessions();
    expect(sessions.map((s) => s.sessionId)).toEqual(['s-tracked']);
  });

  it('are appended with includeUsageOnly=1, in a contract-exact shape', async () => {
    await seedSession('s-tracked');
    seedUsage('s-tracked', { model: 'claude-opus-4-8', cost: 1, totalTokens: 10 });
    seedUsage('s-orphan', {
      model: 'codex-mini',
      tool: 'codex',
      cost: 3,
      totalTokens: 30,
      cwd: '/Users/test/other',
      eventTs: '2026-07-02T09:00:00.000Z',
    });

    const sessions = await getSessions('?includeUsageOnly=1');
    const orphan = sessions.find((s) => s.sessionId === 's-orphan');
    expect(orphan).toBeDefined();
    expect(orphan!.usageOnly).toBe(true);
    expect(orphan!.agent).toBe('codex');
    // `path` and `started` are declared non-nullable strings on AgentSession —
    // a null here would violate the contract every consumer compiles against.
    expect(typeof orphan!.path).toBe('string');
    expect(orphan!.path).toBe('/Users/test/other');
    expect(typeof orphan!.started).toBe('string');
    expect(orphan!.started).toBe('2026-07-02T09:00:00.000Z');
    expect(orphan!.status).toBe('stopped');
    expect(orphan!.isLive).toBe(false);
    expect(orphan!.resumeSupported).toBe(false);
    expect(orphan!.forkSupported).toBe(false);
    expect(orphan!.projectSlug).toBeNull();
    expect(orphan!.assignmentSlug).toBeNull();
    expect(orphan!.transcriptPath).toBeNull();
    expect(orphan!.usage?.totalCost).toBeCloseTo(3, 6);

    // The tracked row is unaffected and never duplicated.
    expect(sessions.filter((s) => s.sessionId === 's-tracked')).toHaveLength(1);
    expect(sessions.find((s) => s.sessionId === 's-tracked')!.usageOnly).toBeUndefined();
  });

  it('falls back to "unknown" agent and empty path when usage carries neither', async () => {
    seedUsage('s-bare', { model: 'm', tool: '', cost: 0, totalTokens: 1, cwd: null });
    const sessions = await getSessions('?includeUsageOnly=1');
    const orphan = sessions.find((s) => s.sessionId === 's-bare');
    expect(orphan!.agent).toBe('unknown');
    expect(orphan!.path).toBe('');
  });

  it('does not leave orphan rows in the sessions table (response-only constructs)', async () => {
    seedUsage('s-orphan', { model: 'claude-opus-4-8', cost: 3, totalTokens: 30 });
    await getSessions('?includeUsageOnly=1');
    // A second call still reports it as usage-only, i.e. reconcile/liveness never
    // persisted it as a real session row.
    const sessions = await getSessions('?includeUsageOnly=1');
    expect(sessions.find((s) => s.sessionId === 's-orphan')!.usageOnly).toBe(true);
    const tracked = await getSessions();
    expect(tracked).toHaveLength(0);
  });
});

describe('POST /api/agent-sessions path sanitization', () => {
  it('stores no path when the request body carries the degenerate root path', async () => {
    const res = await fetch(`${baseUrl}/api/agent-sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        agent: 'claude',
        sessionId: 'post-root-path',
        path: '/',
      }),
    });
    expect(res.status).toBeLessThan(400);

    const [session] = await getSessions();
    expect(session.sessionId).toBe('post-root-path');
    // Boundary sanitization in appendSession covers the POST route too.
    expect(session.path === '' || session.path === null).toBe(true);
  });
});
