import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import { initUsageDb, closeUsageDb, resetUsageDb, upsertEvent } from '../db/usage-db.js';
import { initSessionDb, closeSessionDb, resetSessionDb } from '../dashboard/session-db.js';
import { appendSession, setSessionPinned, setSessionArchived, getSessionById } from '../dashboard/agent-sessions.js';
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
  page?: {
    page: number; pageSize: number; totalCount: number; pageCount: number;
    attribution?: string;
    attributionCounts?: Record<string, number>;
  };
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
    expect(body.page).toMatchObject({ page: 0, pageSize: 10, totalCount: 25, pageCount: 3 });
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

  it('uses each date\'s own offset across a DST boundary', async () => {
    // A range spanning a DST change has two different UTC offsets. Anchoring
    // both bounds on the FROM date's offset makes the TO boundary an hour wrong.
    //
    // Winter 420 (UTC-7) for the from-date, summer 360 (UTC-6) for the to-date.
    // Correct `to` bound for local 2026-07-15 is 2026-07-16T05:59:59.999Z.
    //
    // These two rows discriminate between all three behaviors:
    //   at-0300 (2026-07-16T03:00Z = Jul 15 21:00 local summer) -> INCLUDE
    //   at-0630 (2026-07-16T06:30Z = Jul 16 00:30 local summer) -> EXCLUDE
    // UTC(0) bound 07-15T23:59:59Z excludes both; a single winter offset (420)
    // bound 07-16T06:59:59Z includes both. Only per-date offsets give one row.
    await seedSession('at-0300', { started: '2026-07-16T03:00:00.000Z' });
    await seedSession('at-0630', { started: '2026-07-16T06:30:00.000Z' });

    const body = await get(
      '?pageSize=10&startedFrom=2026-01-15&startedTo=2026-07-15'
      + '&tzOffsetFrom=420&tzOffsetTo=360',
    );
    expect(body.sessions.map((s) => s.sessionId)).toEqual(['at-0300']);
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

describe('attribution filtering', () => {
  async function seedMixed(): Promise<void> {
    await seedSession('with-assignment', { projectSlug: 'alpha', assignmentSlug: 'task' });
    await seedSession('adhoc-1');
    await seedSession('adhoc-2');
    seedUsage('spend-orphan-1', { cost: 1 });
    seedUsage('spend-orphan-2', { cost: 2 });
  }

  it('defaults to real sessions and excludes spend-only rows', async () => {
    await seedMixed();
    const body = await get('?pageSize=50');
    expect(body.sessions.map((s) => s.sessionId).sort()).toEqual([
      'adhoc-1', 'adhoc-2', 'with-assignment',
    ]);
    expect(body.page?.totalCount).toBe(3);
  });

  it('isolates ad-hoc sessions — the ones with no assignment', async () => {
    await seedMixed();
    const body = await get('?pageSize=50&attribution=unassigned');
    expect(body.sessions.map((s) => s.sessionId).sort()).toEqual(['adhoc-1', 'adhoc-2']);
    // Ad-hoc sessions are REAL sessions, not synthetic spend rows: they must
    // keep the properties that make them actionable.
    expect(body.sessions.every((s) => !s.usageOnly)).toBe(true);
  });

  it('isolates assigned sessions', async () => {
    await seedMixed();
    const body = await get('?pageSize=50&attribution=assigned');
    expect(body.sessions.map((s) => s.sessionId)).toEqual(['with-assignment']);
  });

  it('isolates spend-only rows', async () => {
    await seedMixed();
    const body = await get('?pageSize=50&attribution=usage-only');
    expect(body.sessions.map((s) => s.sessionId).sort()).toEqual([
      'spend-orphan-1', 'spend-orphan-2',
    ]);
    expect(body.sessions.every((s) => s.usageOnly)).toBe(true);
  });

  it('shows everything under `all`', async () => {
    await seedMixed();
    const body = await get('?pageSize=50&attribution=all');
    expect(body.page?.totalCount).toBe(5);
  });

  it('reports counts for every bucket so the filter can show what it hides', async () => {
    await seedMixed();
    const body = await get('?pageSize=50');
    expect(body.page?.attributionCounts).toEqual({
      tracked: 3,
      assigned: 1,
      unassigned: 2,
      'usage-only': 2,
      all: 5,
    });
  });

  it('rejects attribution on the unpaged path instead of silently ignoring it', async () => {
    // The unpaged branch has no filter layer, so honoring `attribution` there is
    // impossible; silently returning every session to a caller that asked for a
    // subset is the dangerous outcome.
    await seedMixed();
    const response = await fetch(`${baseUrl}/api/agent-sessions?attribution=assigned`);
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toMatch(/requires .?pageSize/);
  });

  it('leaves the unpaged path working when no attribution is sent', async () => {
    await seedMixed();
    const response = await fetch(`${baseUrl}/api/agent-sessions?includeUsageOnly=1`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as PagedBody;
    expect(body.sessions).toHaveLength(5);
    expect(body.page).toBeUndefined();
  });

  it('falls back to the default on an unknown attribution', async () => {
    await seedMixed();
    const body = await get('?pageSize=50&attribution=nonsense');
    expect(body.page?.attribution).toBe('tracked');
    expect(body.page?.totalCount).toBe(3);
  });

  it('composes with paging, search, and sort', async () => {
    await seedMany(12, 'adhoc');
    await seedSession('bound', { projectSlug: 'alpha', assignmentSlug: 'task' });
    seedUsage('orphan-x', { cost: 5 });

    const p0 = await get('?pageSize=5&page=0&attribution=unassigned&sort=started_desc');
    expect(p0.sessions).toHaveLength(5);
    expect(p0.page?.totalCount).toBe(12);
    expect(p0.sessions.every((s) => !s.usageOnly)).toBe(true);

    const searched = await get('?pageSize=5&attribution=unassigned&search=adhoc-0003');
    expect(searched.sessions.map((s) => s.sessionId)).toEqual(['adhoc-0003']);
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

// --- Curation under paging: pin, archive, name ------------------------------

function curate(sessionId: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}/api/agent-sessions/${sessionId}/curation`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('pinned-first ordering spans the whole result set', () => {
  it('hoists a pinned session from a later page onto page 0', async () => {
    // 25 sessions, newest last. Under `started_desc` the OLDEST (s-0000) sits
    // on the final page. Pinning it must move it to the top of page 0 — the
    // behaviour a client-side comparator could not produce, because it only
    // ever sees the loaded page.
    await seedMany(25);
    expect(setSessionPinned('s-0000', true)).toBe(true);

    const first = await get('?pageSize=10&page=0');
    expect(first.sessions[0]?.sessionId).toBe('s-0000');
    expect(first.page?.totalCount).toBe(25);
  });

  it.each(['started_desc', 'started_asc', 'assignment_asc', 'agent_asc'] as const)(
    'keeps pinned sessions leading under the SQL sort %s',
    async (sort) => {
      await seedMany(12);
      expect(setSessionPinned('s-0005', true)).toBe(true);

      const body = await get(`?pageSize=5&page=0&sort=${sort}`);
      expect(body.sessions[0]?.sessionId).toBe('s-0005');
    },
  );

  it.each(['spend_desc', 'tokens_desc', 'duration_desc', 'duration_asc'] as const)(
    'keeps pinned sessions leading under the MERGE sort %s',
    async (sort) => {
      // These sorts bypass the SQL ORDER BY entirely and rank in JS, so they
      // need their own pinned-first pass. Give another session the highest
      // spend/tokens so it would otherwise win the ordering outright.
      await seedMany(6);
      seedUsage('s-0003', { cost: 99, totalTokens: 999999 });
      expect(setSessionPinned('s-0001', true)).toBe(true);

      const body = await get(`?pageSize=5&page=0&sort=${sort}`);
      expect(body.sessions[0]?.sessionId).toBe('s-0001');
    },
  );

  it('orders most-recently-pinned first within the pinned group', async () => {
    await seedMany(6);
    setSessionPinned('s-0000', true);
    await new Promise((r) => setTimeout(r, 5)); // distinct ISO stamps
    setSessionPinned('s-0002', true);

    const body = await get('?pageSize=6&page=0');
    expect(body.sessions.slice(0, 2).map((x) => x.sessionId)).toEqual(['s-0002', 's-0000']);
  });
});

describe('archived filtering under paging', () => {
  it('hides archived rows by default and corrects totalCount', async () => {
    await seedMany(10);
    expect(setSessionArchived('s-0009', true)).toBe(true);

    const body = await get('?pageSize=50&page=0');
    expect(body.sessions.map((x) => x.sessionId)).not.toContain('s-0009');
    // The COUNT query must apply the same filter, or the pager advertises
    // pages for rows the page query will never return.
    expect(body.page?.totalCount).toBe(9);
  });

  it('archived=show includes them; archived=only returns exactly them', async () => {
    await seedMany(10);
    setSessionArchived('s-0009', true);
    setSessionArchived('s-0008', true);

    const shown = await get('?pageSize=50&page=0&archived=show');
    expect(shown.page?.totalCount).toBe(10);

    const only = await get('?pageSize=50&page=0&archived=only');
    expect(only.sessions.map((x) => x.sessionId).sort()).toEqual(['s-0008', 's-0009']);
    expect(only.page?.totalCount).toBe(2);
  });

  it('reaches an archived session far outside the loaded page', async () => {
    // The point of server-side filtering: archived=only must find a row that
    // client-side narrowing of page 0 could never have seen.
    await seedMany(60);
    setSessionArchived('s-0000', true);

    const only = await get('?pageSize=10&page=0&archived=only');
    expect(only.sessions.map((x) => x.sessionId)).toEqual(['s-0000']);
  });

  it('an unknown archived value falls back to the default rather than 400ing', async () => {
    await seedMany(3);
    setSessionArchived('s-0000', true);
    const body = await get('?pageSize=50&page=0&archived=bogus');
    expect(body.sessions.map((x) => x.sessionId)).not.toContain('s-0000');
  });

  it('attribution bucket counts respect the current archived view', async () => {
    await seedMany(5);
    setSessionArchived('s-0004', true);
    const body = await get('?pageSize=50&page=0');
    // 4 visible, not 5 — the counts share the query's archived clause.
    expect(body.page?.attributionCounts?.tracked).toBe(4);
  });
});

describe('naming a session (D14)', () => {
  it('sets a name and marks it human-authored', async () => {
    await seedSession('named');
    expect((await curate('named', { name: '  Refactor the parser  ' })).status).toBe(200);

    const row = getSessionById('named');
    expect(row?.description).toBe('Refactor the parser'); // trimmed
    expect(row?.descriptionSource).toBe('human');
  });

  it('clearing the name releases the row back to the summarizer', async () => {
    await seedSession('named2');
    await curate('named2', { name: 'Temporary label' });
    expect((await curate('named2', { name: '' })).status).toBe(200);

    const row = getSessionById('named2');
    expect(row?.description).toBeNull();
    // Source back to null, NOT frozen at 'human' — otherwise an empty name
    // would block auto-summarization of that session forever.
    expect(row?.descriptionSource).toBeNull();
  });

  it('a named session is findable by the server-side search', async () => {
    await seedMany(30);
    await curate('s-0000', { name: 'zebra-marker' });

    const body = await get('?pageSize=10&page=0&search=zebra-marker');
    expect(body.sessions.map((x) => x.sessionId)).toEqual(['s-0000']);
  });

  it('rejects a non-string name and an over-long one', async () => {
    await seedSession('named3');
    expect((await curate('named3', { name: 42 })).status).toBe(400);
    expect((await curate('named3', { name: 'x'.repeat(201) })).status).toBe(400);
    expect((await curate('named3', { name: 'x'.repeat(200) })).status).toBe(200);
  });

  it('accepts null to clear, and 400s on an empty body', async () => {
    await seedSession('named4');
    expect((await curate('named4', { name: null })).status).toBe(200);
    expect((await curate('named4', {})).status).toBe(400);
  });

  it('404s for an unknown session and 400s for a malformed id', async () => {
    expect((await curate('no-such-session', { name: 'x' })).status).toBe(404);
    expect((await curate('bad%20id!', { name: 'x' })).status).toBe(400);
  });
});
