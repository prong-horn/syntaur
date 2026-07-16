import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  initSessionDb,
  closeSessionDb,
  resetSessionDb,
  getSessionDb,
} from '../dashboard/session-db.js';
import {
  appendSession,
  listAllSessions,
  reconcileLaunchPlaceholder,
  consumeLaunchMarkers,
} from '../dashboard/agent-sessions.js';

let testDir: string;
let dbPath: string;
let prevHome: string | undefined;
let prevLaunchId: string | undefined;
let prevHostedBy: string | undefined;

const LAUNCH_ID = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const REAL_ID = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'syntaur-launch-corr-'));
  dbPath = resolve(testDir, 'syntaur.db');
  prevHome = process.env.SYNTAUR_HOME;
  process.env.SYNTAUR_HOME = resolve(testDir, 'home');
  prevLaunchId = process.env.SYNTAUR_LAUNCH_ID;
  prevHostedBy = process.env.SYNTAUR_HOSTED_BY;
  delete process.env.SYNTAUR_LAUNCH_ID;
  delete process.env.SYNTAUR_HOSTED_BY;
  resetSessionDb();
  initSessionDb(dbPath);
});

afterEach(async () => {
  closeSessionDb();
  if (prevHome === undefined) delete process.env.SYNTAUR_HOME;
  else process.env.SYNTAUR_HOME = prevHome;
  if (prevLaunchId === undefined) delete process.env.SYNTAUR_LAUNCH_ID;
  else process.env.SYNTAUR_LAUNCH_ID = prevLaunchId;
  if (prevHostedBy === undefined) delete process.env.SYNTAUR_HOSTED_BY;
  else process.env.SYNTAUR_HOSTED_BY = prevHostedBy;
  await rm(testDir, { recursive: true, force: true });
});

/** The cockpit's pre-inserted placeholder row: hosted_by + pid + an open engagement. */
async function insertPlaceholder(sessionId = LAUNCH_ID): Promise<void> {
  await appendSession('', {
    sessionId,
    agent: 'claude',
    started: '2026-07-16T00:00:00.000Z',
    status: 'active',
    path: '/w/a',
    pid: 4242,
    projectSlug: 'proj',
    assignmentSlug: 'a1',
    hostedBy: 'syntaurd',
  });
}

function countKeyedTo(id: string): { sessions: number; engagement: number } {
  const db = getSessionDb();
  return {
    sessions: (db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE session_id = ?').get(id) as { n: number }).n,
    engagement: (db.prepare('SELECT COUNT(*) AS n FROM engagement WHERE session_id = ?').get(id) as { n: number }).n,
  };
}

describe('reconcileLaunchPlaceholder — migrate path (no real row yet)', () => {
  it('re-keys the sessions row onto the real id, preserving hosted_by and pid', async () => {
    await insertPlaceholder();
    await reconcileLaunchPlaceholder(LAUNCH_ID, REAL_ID);

    const all = await listAllSessions('');
    const real = all.find((s) => s.sessionId === REAL_ID);
    expect(real).toBeDefined();
    expect(real?.hostedBy).toBe('syntaurd');
    expect(real?.pid).toBe(4242);
    expect(all.find((s) => s.sessionId === LAUNCH_ID)).toBeUndefined();
  });

  it('re-keys the engagement rows too, preserving the binding', async () => {
    await insertPlaceholder();
    await reconcileLaunchPlaceholder(LAUNCH_ID, REAL_ID);

    expect(countKeyedTo(LAUNCH_ID)).toEqual({ sessions: 0, engagement: 0 });
    expect(countKeyedTo(REAL_ID).engagement).toBe(1);
    const real = (await listAllSessions('')).find((s) => s.sessionId === REAL_ID);
    expect(real?.projectSlug).toBe('proj');
    expect(real?.assignmentSlug).toBe('a1');
  });

  it('a subsequent hook upsert under the real id converges onto the reconciled row', async () => {
    await insertPlaceholder();
    await reconcileLaunchPlaceholder(LAUNCH_ID, REAL_ID);

    // The hook registers with no hostedBy — COALESCE must keep the stamp.
    await appendSession('', {
      sessionId: REAL_ID,
      agent: 'claude',
      started: '2026-07-16T00:00:10.000Z',
      status: 'active',
      path: '/w/a',
      projectSlug: null,
      assignmentSlug: null,
      transcriptPath: '/t/real.jsonl',
    });

    const all = await listAllSessions('');
    expect(all.filter((s) => s.sessionId === REAL_ID)).toHaveLength(1);
    const real = all.find((s) => s.sessionId === REAL_ID);
    expect(real?.hostedBy).toBe('syntaurd'); // survived the hook upsert
    expect(real?.transcriptPath).toBe('/t/real.jsonl'); // hook data landed
  });
});

describe('reconcileLaunchPlaceholder — merge path (hook registered first)', () => {
  it('copies provenance onto the real row, deletes the placeholder, orphans nothing', async () => {
    await insertPlaceholder();
    // The hook raced ahead and created the real row with no provenance.
    await appendSession('', {
      sessionId: REAL_ID,
      agent: 'claude',
      started: '2026-07-16T00:00:05.000Z',
      status: 'active',
      path: '/w/a',
      projectSlug: 'proj',
      assignmentSlug: 'a1',
    });

    await reconcileLaunchPlaceholder(LAUNCH_ID, REAL_ID);

    const all = await listAllSessions('');
    const real = all.find((s) => s.sessionId === REAL_ID);
    expect(real?.hostedBy).toBe('syntaurd'); // copied from the placeholder
    expect(real?.pid).toBe(4242);
    expect(all.find((s) => s.sessionId === LAUNCH_ID)).toBeUndefined();
    // No sessions OR engagement row may remain keyed to the launch id.
    expect(countKeyedTo(LAUNCH_ID)).toEqual({ sessions: 0, engagement: 0 });
  });

  it('leaves exactly one OPEN engagement after the merge (partial unique index holds)', async () => {
    await insertPlaceholder();
    await appendSession('', {
      sessionId: REAL_ID,
      agent: 'claude',
      started: '2026-07-16T00:00:05.000Z',
      status: 'active',
      path: '/w/a',
      projectSlug: 'proj',
      assignmentSlug: 'a1',
    });

    await reconcileLaunchPlaceholder(LAUNCH_ID, REAL_ID);

    const db = getSessionDb();
    const open = db
      .prepare('SELECT COUNT(*) AS n FROM engagement WHERE session_id = ? AND ended_at IS NULL')
      .get(REAL_ID) as { n: number };
    expect(open.n).toBe(1);
    // The placeholder's interval survives as CLOSED history under the real id.
    const closed = db
      .prepare("SELECT COUNT(*) AS n FROM engagement WHERE session_id = ? AND close_reason = 'launch-reconcile'")
      .get(REAL_ID) as { n: number };
    expect(closed.n).toBe(1);
  });

  it('does not clobber a hostedBy the real row already carries', async () => {
    await insertPlaceholder();
    await appendSession('', {
      sessionId: REAL_ID,
      agent: 'claude',
      started: '2026-07-16T00:00:05.000Z',
      status: 'active',
      path: '/w/a',
      projectSlug: 'proj',
      assignmentSlug: 'a1',
      hostedBy: 'tmux',
    });

    await reconcileLaunchPlaceholder(LAUNCH_ID, REAL_ID);

    const real = (await listAllSessions('')).find((s) => s.sessionId === REAL_ID);
    expect(real?.hostedBy).toBe('tmux'); // write-if-null, never overwrite
  });
});

describe('reconcileLaunchPlaceholder — a launch may only be claimed once', () => {
  // The markers persist in the worker's env for the whole session, so every
  // descendant process inherits them. Under Branch A the launch id IS the live
  // session's row, so a second consumer arriving with a different real id must
  // never be allowed to re-key it.
  const CHILD_ID = 'cccccccc-3333-4333-8333-cccccccccccc';

  it('refuses to re-key a row a real registration already claimed (transcript evidence)', async () => {
    await insertPlaceholder(); // launch row, keyed LAUNCH_ID
    // Branch A: the launched agent registers under the SAME id, so the row
    // stays keyed to LAUNCH_ID but is now a real, live session.
    await appendSession('', {
      sessionId: LAUNCH_ID,
      agent: 'claude',
      started: '2026-07-16T00:00:01.000Z',
      status: 'active',
      path: '/w/a',
      projectSlug: 'proj',
      assignmentSlug: 'a1',
      transcriptPath: '/t/parent.jsonl',
    });

    // A subagent hook / `track-session --session-id CHILD_ID` inherits the env.
    await reconcileLaunchPlaceholder(LAUNCH_ID, CHILD_ID);

    const all = await listAllSessions('');
    // The parent must still exist under its own id, with its binding intact.
    const parent = all.find((s) => s.sessionId === LAUNCH_ID);
    expect(parent).toBeDefined();
    expect(parent?.transcriptPath).toBe('/t/parent.jsonl');
    expect(parent?.hostedBy).toBe('syntaurd');
    expect(parent?.assignmentSlug).toBe('a1');
    // ...and the child must NOT have stolen it.
    expect(all.find((s) => s.sessionId === CHILD_ID)).toBeUndefined();
    expect(countKeyedTo(LAUNCH_ID).engagement).toBe(1); // engagement never moved
  });

  it('refuses to re-key once original_head_sha evidences a claim (no transcript yet)', async () => {
    await insertPlaceholder();
    await appendSession('', {
      sessionId: LAUNCH_ID,
      agent: 'claude',
      started: '2026-07-16T00:00:01.000Z',
      status: 'active',
      path: '/w/a',
      projectSlug: 'proj',
      assignmentSlug: 'a1',
      originalHeadSha: 'abc123',
    });

    await reconcileLaunchPlaceholder(LAUNCH_ID, CHILD_ID);

    expect((await listAllSessions('')).find((s) => s.sessionId === LAUNCH_ID)).toBeDefined();
    expect((await listAllSessions('')).find((s) => s.sessionId === CHILD_ID)).toBeUndefined();
  });

  it('still re-keys a PRISTINE placeholder — the intended shell-alias flow is unaffected', async () => {
    await insertPlaceholder(); // never claimed: no transcript, no head sha
    await reconcileLaunchPlaceholder(LAUNCH_ID, REAL_ID);
    const all = await listAllSessions('');
    expect(all.find((s) => s.sessionId === REAL_ID)?.hostedBy).toBe('syntaurd');
    expect(all.find((s) => s.sessionId === LAUNCH_ID)).toBeUndefined();
  });

  it('a second consumer after a successful migrate is a no-op (the row is gone)', async () => {
    await insertPlaceholder();
    await reconcileLaunchPlaceholder(LAUNCH_ID, REAL_ID); // first claim wins
    await reconcileLaunchPlaceholder(LAUNCH_ID, CHILD_ID); // a subagent, later
    const all = await listAllSessions('');
    expect(all.find((s) => s.sessionId === REAL_ID)).toBeDefined();
    expect(all.find((s) => s.sessionId === CHILD_ID)).toBeUndefined();
  });
});

describe('reconcileLaunchPlaceholder — no-op paths', () => {
  it('no-ops when launchId === realSessionId (the --session-id branch)', async () => {
    await insertPlaceholder(REAL_ID);
    await reconcileLaunchPlaceholder(REAL_ID, REAL_ID);
    const all = await listAllSessions('');
    expect(all.filter((s) => s.sessionId === REAL_ID)).toHaveLength(1);
    expect(all.find((s) => s.sessionId === REAL_ID)?.hostedBy).toBe('syntaurd');
  });

  it('no-ops when no placeholder row exists (any non-cockpit launch)', async () => {
    await appendSession('', {
      sessionId: REAL_ID,
      agent: 'claude',
      started: '2026-07-16T00:00:00.000Z',
      status: 'active',
      path: '/w/a',
      projectSlug: null,
      assignmentSlug: null,
    });
    await expect(reconcileLaunchPlaceholder(LAUNCH_ID, REAL_ID)).resolves.toBeUndefined();
    expect((await listAllSessions('')).filter((s) => s.sessionId === REAL_ID)).toHaveLength(1);
  });

  it('no-ops on empty ids and never throws', async () => {
    await expect(reconcileLaunchPlaceholder('', REAL_ID)).resolves.toBeUndefined();
    await expect(reconcileLaunchPlaceholder(LAUNCH_ID, '')).resolves.toBeUndefined();
  });
});

describe('consumeLaunchMarkers', () => {
  it('reconciles the placeholder and returns the backend stamp from the env', async () => {
    await insertPlaceholder();
    process.env.SYNTAUR_LAUNCH_ID = LAUNCH_ID;
    process.env.SYNTAUR_HOSTED_BY = 'syntaurd';

    const markers = await consumeLaunchMarkers(REAL_ID);

    expect(markers).toEqual({ hostedBy: 'syntaurd' });
    const all = await listAllSessions('');
    expect(all.find((s) => s.sessionId === REAL_ID)?.hostedBy).toBe('syntaurd');
    expect(all.find((s) => s.sessionId === LAUNCH_ID)).toBeUndefined();
  });

  it('returns the claude-bg stamp with no placeholder (the native --bg tier)', async () => {
    process.env.SYNTAUR_HOSTED_BY = 'claude-bg';
    expect(await consumeLaunchMarkers(REAL_ID)).toEqual({ hostedBy: 'claude-bg' });
  });

  it('returns {} when no markers are set (every non-cockpit launch)', async () => {
    expect(await consumeLaunchMarkers(REAL_ID)).toEqual({});
  });

  it('ignores an unrecognized SYNTAUR_HOSTED_BY value', async () => {
    process.env.SYNTAUR_HOSTED_BY = 'not-a-backend';
    expect(await consumeLaunchMarkers(REAL_ID)).toEqual({});
  });

  it('an upsert carrying the stamp sets it on a NULL row and never clobbers an existing value', async () => {
    // write-if-null via COALESCE: first upsert stamps, second cannot change it.
    await appendSession('', {
      sessionId: REAL_ID,
      agent: 'claude',
      started: '2026-07-16T00:00:00.000Z',
      status: 'active',
      path: '/w/a',
      projectSlug: null,
      assignmentSlug: null,
    });
    expect((await listAllSessions('')).find((s) => s.sessionId === REAL_ID)?.hostedBy).toBeNull();

    process.env.SYNTAUR_HOSTED_BY = 'claude-bg';
    const first = await consumeLaunchMarkers(REAL_ID);
    await appendSession('', {
      ...first,
      sessionId: REAL_ID,
      agent: 'claude',
      started: '2026-07-16T00:00:01.000Z',
      status: 'active',
      path: '/w/a',
      projectSlug: null,
      assignmentSlug: null,
    });
    expect((await listAllSessions('')).find((s) => s.sessionId === REAL_ID)?.hostedBy).toBe('claude-bg');

    process.env.SYNTAUR_HOSTED_BY = 'tmux';
    const second = await consumeLaunchMarkers(REAL_ID);
    await appendSession('', {
      ...second,
      sessionId: REAL_ID,
      agent: 'claude',
      started: '2026-07-16T00:00:02.000Z',
      status: 'active',
      path: '/w/a',
      projectSlug: null,
      assignmentSlug: null,
    });
    expect((await listAllSessions('')).find((s) => s.sessionId === REAL_ID)?.hostedBy).toBe('claude-bg');
  });
});
