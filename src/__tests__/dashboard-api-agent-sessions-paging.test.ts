import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import { initUsageDb, closeUsageDb, resetUsageDb, upsertEvent } from '../db/usage-db.js';
import { initSessionDb, closeSessionDb, resetSessionDb } from '../dashboard/session-db.js';
import { appendSession } from '../dashboard/agent-sessions.js';
import { createAgentSessionsRouter, localDateToUtcBounds } from '../dashboard/api-agent-sessions.js';
import type { AgentSessionWithLiveness } from '../dashboard/types.js';

let sandbox: string;
let projectsDir: string;
let server: ReturnType<express.Express['listen']>;
let baseUrl: string;
let originalEnv: string | undefined;

/** Workspace membership stub — the real one reads project frontmatter from disk. */
const workspaceMembers: Record<string, { projectSlugs: string[]; standaloneAssignmentIds: string[] }> = {};

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'syntaur-sessions-paging-'));
  projectsDir = resolve(sandbox, 'projects');
  await mkdir(projectsDir, { recursive: true });
  originalEnv = process.env.SYNTAUR_HOME;
  process.env.SYNTAUR_HOME = sandbox;
  resetUsageDb();
  resetSessionDb();
  initSessionDb();
  initUsageDb();
  for (const key of Object.keys(workspaceMembers)) delete workspaceMembers[key];

  const app = express();
  app.use(express.json());
  app.use(
    '/api/agent-sessions',
    createAgentSessionsRouter(projectsDir, undefined, undefined, {
      resolveWorkspaceMembers: async (_p, _a, workspace) =>
        workspaceMembers[workspace] ?? { projectSlugs: [], standaloneAssignmentIds: [] },
    }),
  );
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

function seedUsage(sessionId: string, opts: { cost: number; totalTokens?: number; tool?: string; cwd?: string; eventTs?: string }): void {
  upsertEvent({
    sessionId,
    model: 'claude-opus-4',
    tool: opts.tool ?? 'claude',
    eventTs: opts.eventTs ?? '2026-07-01T11:00:00.000Z',
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    totalTokens: opts.totalTokens ?? 0,
    totalCost: opts.cost,
    cwd: opts.cwd ?? '/Users/test/repo',
    projectSlug: '',
    assignmentSlug: '',
    rawJson: null,
  } as Parameters<typeof upsertEvent>[0]);
}

interface PagedBody {
  sessions: AgentSessionWithLiveness[];
  page?: { page: number; pageSize: number; totalCount: number; pageCount: number };
}

async function get(query: string): Promise<PagedBody> {
  const response = await fetch(`${baseUrl}/api/agent-sessions${query}`);
  expect(response.status).toBe(200);
  return (await response.json()) as PagedBody;
}

/** Seed `count` sessions one minute apart, newest last. */
async function seedMany(count: number, prefix = 's'): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    const minute = String(i).padStart(2, '0');
    await seedSession(`${prefix}-${String(i).padStart(4, '0')}`, {
      started: `2026-07-01T10:${minute}:00.000Z`,
    });
  }
}

describe('GET /api/agent-sessions paging', () => {
  it('returns the full set and no page object when pageSize is absent', async () => {
    await seedMany(5);
    const body = await get('');
    expect(body.sessions).toHaveLength(5);
    expect(body.page).toBeUndefined();
  });

  it('returns exactly pageSize rows with correct totals', async () => {
    await seedMany(25);
    const body = await get('?pageSize=10&page=0');
    expect(body.sessions).toHaveLength(10);
    expect(body.page).toEqual({ page: 0, pageSize: 10, totalCount: 25, pageCount: 3 });
  });

  it('returns the remainder on the last page, and nothing past the end', async () => {
    await seedMany(25);
    const last = await get('?pageSize=10&page=2');
    expect(last.sessions).toHaveLength(5);

    const past = await get('?pageSize=10&page=99');
    expect(past.sessions).toHaveLength(0);
    // The count still describes the whole set, so the UI can clamp back.
    expect(past.page?.totalCount).toBe(25);
  });

  it('never duplicates or skips a row across pages when started values tie', async () => {
    // Every session shares one timestamp: without a stable secondary sort key
    // SQLite may order them differently per query, so a row can appear on two
    // pages and another can vanish entirely.
    for (let i = 0; i < 30; i += 1) {
      await seedSession(`tie-${String(i).padStart(4, '0')}`, { started: '2026-07-01T10:00:00.000Z' });
    }
    const seen: string[] = [];
    for (let page = 0; page < 3; page += 1) {
      const body = await get(`?pageSize=10&page=${page}`);
      seen.push(...body.sessions.map((s) => s.sessionId));
    }
    expect(seen).toHaveLength(30);
    expect(new Set(seen).size).toBe(30);
  });

  it('clamps pageSize to the ceiling and ignores malformed paging params', async () => {
    await seedMany(3);
    expect((await get('?pageSize=99999')).page?.pageSize).toBe(500);
    // A malformed pageSize opts OUT of paging rather than erroring.
    expect((await get('?pageSize=abc')).page).toBeUndefined();
    // A malformed page falls back to the first page.
    expect((await get('?pageSize=2&page=-4')).page?.page).toBe(0);
    expect((await get('?pageSize=2&page=notanumber')).page?.page).toBe(0);
  });

  it('rejects an unknown sort by falling back to the default', async () => {
    await seedMany(3);
    const body = await get('?pageSize=10&sort=; DROP TABLE sessions');
    expect(body.sessions).toHaveLength(3);
    // Default is started_desc — newest first.
    expect(body.sessions[0].sessionId).toBe('s-0002');
  });
});

describe('paged filtering spans the whole set, not the page', () => {
  it('finds a match that sorts far outside the first page', async () => {
    await seedMany(300);
    // Oldest session sorts last under the default started_desc — position ~299.
    await seedSession('needle-session', {
      started: '2020-01-01T00:00:00.000Z',
      path: '/Users/test/very-distinctive-path',
    });

    const body = await get('?pageSize=10&page=0&search=very-distinctive-path');
    expect(body.page?.totalCount).toBe(1);
    expect(body.sessions.map((s) => s.sessionId)).toEqual(['needle-session']);
  });

  it('treats % and _ as literal characters, not SQL wildcards', async () => {
    await seedSession('literal-pct', { description: 'progress 50% done' });
    await seedSession('literal-other', { description: 'nothing special' });

    // As a LIKE pattern '%' would match everything; as a literal it matches one.
    const pct = await get(`?pageSize=10&search=${encodeURIComponent('50%')}`);
    expect(pct.sessions.map((s) => s.sessionId)).toEqual(['literal-pct']);

    // '_' is LIKE's single-character wildcard; literally, it matches nothing here.
    const underscore = await get(`?pageSize=10&search=${encodeURIComponent('progress_50')}`);
    expect(underscore.sessions).toHaveLength(0);
  });

  it('matches a query spanning two fields, as the old concatenated search did', async () => {
    // The client joined every searchable field with spaces and ran one
    // includes(), so "alpha task" matched project 'alpha' + assignment 'task'.
    // Per-column ORs would match neither.
    await seedSession('cross-field', { projectSlug: 'alpha', assignmentSlug: 'task' });
    await seedSession('unrelated', { projectSlug: 'beta', assignmentSlug: 'other' });

    const body = await get(`?pageSize=10&search=${encodeURIComponent('alpha task')}`);
    expect(body.sessions.map((s) => s.sessionId)).toEqual(['cross-field']);
  });

  it('sorts a live session by elapsed time, not as zero-length', async () => {
    // A live session (ended IS NULL) has duration `now - started`. Ordering it
    // in SQL via COALESCE(ended, started) would make it zero-length and sort it
    // last under duration_desc — the opposite end from where it belongs.
    await seedSession('live-long', { started: '2020-01-01T00:00:00.000Z', status: 'active' });
    await seedSession('finished-short', {
      started: '2026-07-01T10:00:00.000Z', ended: '2026-07-01T10:05:00.000Z', status: 'completed',
    });

    const body = await get('?pageSize=10&sort=duration_desc');
    expect(body.sessions[0].sessionId).toBe('live-long');
  });

  it('filters by local calendar date using the caller timezone offset', async () => {
    // 2026-07-02T02:30Z is 2026-07-01 at 20:30 in UTC-6, so a filter for the
    // local day 2026-07-01 must include it. Comparing the bare date against the
    // UTC timestamp would drop it.
    await seedSession('late-evening-local', { started: '2026-07-02T02:30:00.000Z' });
    await seedSession('next-day-local', { started: '2026-07-02T18:00:00.000Z' });

    const offset = 360; // getTimezoneOffset() for UTC-6
    const body = await get(`?pageSize=10&startedFrom=2026-07-01&startedTo=2026-07-01&tzOffset=${offset}`);
    expect(body.sessions.map((s) => s.sessionId)).toEqual(['late-evening-local']);
  });
});

describe('usage-only rows in the paged union', () => {
  it('includes orphan rows and counts them in totalCount', async () => {
    await seedMany(3);
    seedUsage('orphan-1', { cost: 1.5, totalTokens: 100 });
    seedUsage('orphan-2', { cost: 2.5, totalTokens: 200 });

    const without = await get('?pageSize=50');
    expect(without.page?.totalCount).toBe(3);

    const with_ = await get('?pageSize=50&includeUsageOnly=1');
    expect(with_.page?.totalCount).toBe(5);
    const orphans = with_.sessions.filter((s) => s.usageOnly);
    expect(orphans.map((s) => s.sessionId).sort()).toEqual(['orphan-1', 'orphan-2']);
  });

  it('pages the union without losing orphans on later pages', async () => {
    await seedMany(8);
    seedUsage('orphan-old', { cost: 1, eventTs: '2019-01-01T00:00:00.000Z' });

    const ids: string[] = [];
    for (let page = 0; page < 3; page += 1) {
      const body = await get(`?pageSize=3&page=${page}&includeUsageOnly=1`);
      ids.push(...body.sessions.map((s) => s.sessionId));
    }
    expect(ids).toHaveLength(9);
    expect(ids).toContain('orphan-old');
  });
});

describe('spend and token sorts', () => {
  it('ranks by cost across the whole set and keeps zero-usage sessions', async () => {
    await seedSession('rich', { started: '2026-07-01T10:00:00.000Z' });
    await seedSession('poor', { started: '2026-07-01T10:01:00.000Z' });
    await seedSession('free-a', { started: '2026-07-01T10:02:00.000Z' });
    await seedSession('free-b', { started: '2026-07-01T10:03:00.000Z' });
    seedUsage('rich', { cost: 10, totalTokens: 1000 });
    seedUsage('poor', { cost: 1, totalTokens: 10 });

    const body = await get('?pageSize=50&sort=spend_desc');
    // Zero-usage tracked sessions must participate as zero-cost rows rather than
    // being dropped — ranking only over the usage map would lose them.
    expect(body.page?.totalCount).toBe(4);
    expect(body.sessions.map((s) => s.sessionId)).toEqual(['rich', 'poor', 'free-b', 'free-a']);
  });

  it('pages a spend ranking without dropping the zero-cost tail', async () => {
    await seedMany(10);
    seedUsage('s-0000', { cost: 5 });

    const first = await get('?pageSize=4&page=0&sort=spend_desc');
    expect(first.sessions[0].sessionId).toBe('s-0000');
    expect(first.page?.totalCount).toBe(10);

    const ids: string[] = [];
    for (let page = 0; page < 3; page += 1) {
      const body = await get(`?pageSize=4&page=${page}&sort=spend_desc`);
      ids.push(...body.sessions.map((s) => s.sessionId));
    }
    expect(new Set(ids).size).toBe(10);
  });

  it('ranks by tokens independently of cost', async () => {
    await seedSession('a');
    await seedSession('b');
    seedUsage('a', { cost: 100, totalTokens: 1 });
    seedUsage('b', { cost: 1, totalTokens: 100 });

    const body = await get('?pageSize=10&sort=tokens_desc');
    expect(body.sessions.map((s) => s.sessionId)).toEqual(['b', 'a']);
  });
});

describe('workspace scoping', () => {
  it('includes standalone-assignment sessions in a named workspace', async () => {
    // A named workspace can hold standalone assignments, which have no project —
    // filtering on project slug alone would drop them.
    await seedSession('in-project', { projectSlug: 'alpha', assignmentSlug: 'task' });
    // Both engagement paths must carry assignmentId: 'active' goes through
    // ensureOpenEngagement, 'stopped' through insertClosedEngagement — which
    // used to drop it, orphaning standalone sessions from their workspace.
    await seedSession('standalone-open', {
      assignmentId: 'sa-1', assignmentSlug: 'loose-task', status: 'active',
    });
    await seedSession('standalone-closed', {
      assignmentId: 'sa-1', assignmentSlug: 'loose-task', status: 'stopped',
    });
    await seedSession('elsewhere', { projectSlug: 'beta', assignmentSlug: 'other' });
    workspaceMembers['gridiron'] = { projectSlugs: ['alpha'], standaloneAssignmentIds: ['sa-1'] };

    const body = await get('?pageSize=50&workspace=gridiron');
    expect(body.sessions.map((s) => s.sessionId).sort()).toEqual([
      'in-project', 'standalone-closed', 'standalone-open',
    ]);
  });

  it('puts unattributed and usage-only rows in _ungrouped, not a named workspace', async () => {
    await seedSession('bound', { projectSlug: 'alpha', assignmentSlug: 'task' });
    await seedSession('unbound');
    seedUsage('orphan-x', { cost: 1 });
    workspaceMembers['gridiron'] = { projectSlugs: ['alpha'], standaloneAssignmentIds: [] };
    workspaceMembers['_ungrouped'] = { projectSlugs: [], standaloneAssignmentIds: [] };

    const named = await get('?pageSize=50&workspace=gridiron&includeUsageOnly=1');
    expect(named.sessions.map((s) => s.sessionId)).toEqual(['bound']);

    const ungrouped = await get('?pageSize=50&workspace=_ungrouped&includeUsageOnly=1');
    expect(ungrouped.sessions.map((s) => s.sessionId).sort()).toEqual(['orphan-x', 'unbound']);
  });

  it('does not resurface a filtered-out tracked session as a synthetic orphan', async () => {
    // Regression: "orphan" means "a usage id with no sessions row". If that set
    // is computed from the POST-FILTER session list, any tracked session the
    // filter excluded re-enters as a fake usageOnly row — with null project,
    // wrong metadata, and an inflated totalCount.
    await seedSession('alpha-sess', { projectSlug: 'alpha', assignmentSlug: 'task' });
    seedUsage('alpha-sess', { cost: 3 });
    workspaceMembers['gridiron'] = { projectSlugs: ['alpha'], standaloneAssignmentIds: [] };
    workspaceMembers['_ungrouped'] = { projectSlugs: [], standaloneAssignmentIds: [] };

    const ungrouped = await get('?pageSize=50&workspace=_ungrouped&includeUsageOnly=1');
    expect(ungrouped.sessions).toHaveLength(0);
    expect(ungrouped.page?.totalCount).toBe(0);

    // And it is still correctly present in its own workspace, as a real row.
    const named = await get('?pageSize=50&workspace=gridiron&includeUsageOnly=1');
    expect(named.sessions.map((s) => s.sessionId)).toEqual(['alpha-sess']);
    expect(named.sessions[0].usageOnly).toBeFalsy();
  });

  it('does not resurface a search-excluded tracked session as an orphan', async () => {
    // Same defect via a different filter: the session is excluded by `search`,
    // but its id/cwd could still satisfy the orphan haystack.
    await seedSession('zz-distinct-id', { description: 'nothing matching here' });
    seedUsage('zz-distinct-id', { cost: 2, cwd: '/Users/test/repo' });

    const body = await get('?pageSize=50&includeUsageOnly=1&search=zz-distinct-id');
    // It matches on sessionId, so it must come back exactly once, as a real row.
    expect(body.sessions).toHaveLength(1);
    expect(body.sessions[0].usageOnly).toBeFalsy();
  });

  it('returns nothing for a workspace with no members rather than everything', async () => {
    await seedMany(3);
    workspaceMembers['empty-ws'] = { projectSlugs: [], standaloneAssignmentIds: [] };
    const body = await get('?pageSize=50&workspace=empty-ws');
    expect(body.sessions).toHaveLength(0);
    expect(body.page?.totalCount).toBe(0);
  });
});

describe('localDateToUtcBounds', () => {
  it('maps a local day to its precise UTC instants', () => {
    // UTC-6: local midnight is 06:00Z, local end-of-day is 05:59:59.999Z next day.
    expect(localDateToUtcBounds('2026-07-01', 360, 'start')).toBe('2026-07-01T06:00:00.000Z');
    expect(localDateToUtcBounds('2026-07-01', 360, 'end')).toBe('2026-07-02T05:59:59.999Z');
  });

  it('is identity at UTC and rejects malformed dates', () => {
    expect(localDateToUtcBounds('2026-07-01', 0, 'start')).toBe('2026-07-01T00:00:00.000Z');
    expect(localDateToUtcBounds('07/01/2026', 0, 'start')).toBeUndefined();
    expect(localDateToUtcBounds('', 0, 'start')).toBeUndefined();
  });
});
