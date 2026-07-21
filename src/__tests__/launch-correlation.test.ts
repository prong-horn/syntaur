import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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
  reserveLaunch,
  markLaunchDispatched,
  claimLaunch,
  cancelLaunch,
  getLaunchReservation,
} from '../dashboard/agent-sessions.js';
import { writeJobState } from '../daemon/jobs.js';
import { launchSyntaurd } from '../tui/syntaurd/launch.js';
import { loadSessions } from '../tui/sessions/feed.js';
import { buildRailRows } from '../tui/cockpit/railTypes.js';
import type { AgentConfig } from '../utils/config.js';
import type { JobState } from '../daemon/types.js';

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

describe('launch_reservations lifecycle', () => {
  it('(a) reserve creates a fresh row with null lifecycle fields', () => {
    const ok = reserveLaunch({
      launchId: LAUNCH_ID,
      hostedBy: 'syntaurd',
      agent: 'claude',
      cwd: '/w/a',
      expectedSessionId: 'real-A',
    });
    expect(ok).toBe(true);
    const r = getLaunchReservation(LAUNCH_ID);
    expect(r).toMatchObject({
      launchId: LAUNCH_ID,
      hostedBy: 'syntaurd',
      agent: 'claude',
      cwd: '/w/a',
      expectedSessionId: 'real-A',
      dispatchedAt: null,
      claimedBy: null,
      claimedAt: null,
      canceledAt: null,
    });
    expect(r?.createdAt).toBeTruthy();
  });

  it('(b) markLaunchDispatched stamps once; a second call does not move the timestamp', () => {
    reserveLaunch({ launchId: LAUNCH_ID, hostedBy: 'syntaurd', expectedSessionId: 'real-A' });
    markLaunchDispatched(LAUNCH_ID);
    expect(getLaunchReservation(LAUNCH_ID)?.dispatchedAt).toBeTruthy();

    // Force a distinguishable stamp so a second call's no-op is unambiguous
    // regardless of clock resolution.
    getSessionDb()
      .prepare('UPDATE launch_reservations SET dispatched_at = ? WHERE launch_id = ?')
      .run('2020-01-01T00:00:00.000Z', LAUNCH_ID);
    markLaunchDispatched(LAUNCH_ID);
    expect(getLaunchReservation(LAUNCH_ID)?.dispatchedAt).toBe('2020-01-01T00:00:00.000Z');
  });

  it('(c) bound claim: winner/loser/idempotent re-claim, and intruder-first cannot win regardless of arrival order (review r1 F1)', () => {
    reserveLaunch({ launchId: LAUNCH_ID, hostedBy: 'syntaurd', expectedSessionId: 'real-A' });
    expect(claimLaunch(LAUNCH_ID, 'real-A')).toBe('won');
    expect(claimLaunch(LAUNCH_ID, 'real-B')).toBe('lost');
    expect(claimLaunch(LAUNCH_ID, 'real-A')).toBe('won'); // idempotent re-claim by the owner

    // Intruder-FIRST: on a FRESH bound reservation, the intruder calling
    // BEFORE the root must still lose (claimed_by stays NULL), and the root
    // must still win when it arrives later — the identity check lives
    // inside the CAS WHERE, so arrival order can never decide the winner.
    // SABOTAGE-VERIFIED locally (see Task 15 report / the (g) comment
    // below for the full breakdown): claimLaunch has two redundant identity
    // checks; commenting out BOTH (the pre-check and the CAS WHERE's
    // `expected_session_id = @real`) makes this block fail — the intruder
    // wins. Reverted after confirming; no sabotage code is committed.
    const OTHER_LAUNCH_ID = 'dddddddd-4444-4444-8444-dddddddddddd';
    reserveLaunch({ launchId: OTHER_LAUNCH_ID, hostedBy: 'syntaurd', expectedSessionId: 'real-A' });
    expect(claimLaunch(OTHER_LAUNCH_ID, 'real-B')).toBe('lost');
    expect(getLaunchReservation(OTHER_LAUNCH_ID)?.claimedBy).toBeNull();
    expect(claimLaunch(OTHER_LAUNCH_ID, 'real-A')).toBe('won');
  });

  it("(c2) unbound claim writes nothing — 'unbound' both times (review r2 F1, excluded mode)", () => {
    reserveLaunch({ launchId: LAUNCH_ID, hostedBy: 'syntaurd' }); // no expectedSessionId
    expect(claimLaunch(LAUNCH_ID, 'real-A')).toBe('unbound');
    expect(getLaunchReservation(LAUNCH_ID)?.claimedBy).toBeNull();
    expect(claimLaunch(LAUNCH_ID, 'real-B')).toBe('unbound');
    expect(getLaunchReservation(LAUNCH_ID)?.claimedBy).toBeNull();
  });

  it('(d) a canceled reservation refuses claims; cancel is a no-op once claimed', () => {
    reserveLaunch({ launchId: LAUNCH_ID, hostedBy: 'syntaurd', expectedSessionId: 'real-A' });
    cancelLaunch(LAUNCH_ID);
    expect(getLaunchReservation(LAUNCH_ID)?.canceledAt).toBeTruthy();
    expect(claimLaunch(LAUNCH_ID, 'real-A')).toBe('lost');

    const OTHER_LAUNCH_ID = 'eeeeeeee-5555-4555-8555-eeeeeeeeeeee';
    reserveLaunch({ launchId: OTHER_LAUNCH_ID, hostedBy: 'syntaurd', expectedSessionId: 'real-A' });
    expect(claimLaunch(OTHER_LAUNCH_ID, 'real-A')).toBe('won');
    cancelLaunch(OTHER_LAUNCH_ID); // claim wins — cancel must not touch it
    expect(getLaunchReservation(OTHER_LAUNCH_ID)?.canceledAt).toBeNull();
  });

  it('(d2) reserveLaunch revives a canceled row fresh; refuses a LIVE conflicting id (review r2 F3)', () => {
    reserveLaunch({ launchId: LAUNCH_ID, hostedBy: 'syntaurd', expectedSessionId: 'real-A' });
    markLaunchDispatched(LAUNCH_ID);
    cancelLaunch(LAUNCH_ID);
    expect(getLaunchReservation(LAUNCH_ID)?.canceledAt).toBeTruthy();

    const revivedOk = reserveLaunch({ launchId: LAUNCH_ID, hostedBy: 'tmux', expectedSessionId: 'real-C' });
    expect(revivedOk).toBe(true);
    const revived = getLaunchReservation(LAUNCH_ID);
    expect(revived).toMatchObject({
      hostedBy: 'tmux',
      expectedSessionId: 'real-C',
      dispatchedAt: null,
      claimedBy: null,
      claimedAt: null,
      canceledAt: null,
    });
    expect(revived?.createdAt).toBeTruthy();

    // A LIVE (uncanceled) conflicting id refuses — 0 changes → false — and
    // the live row is untouched.
    const liveOk = reserveLaunch({ launchId: LAUNCH_ID, hostedBy: 'syntaurd', expectedSessionId: 'real-D' });
    expect(liveOk).toBe(false);
    expect(getLaunchReservation(LAUNCH_ID)).toEqual(revived);
  });

  it("(e) claimLaunch returns 'none' when no reservation row exists (legacy launch)", () => {
    expect(claimLaunch('never-reserved', 'x')).toBe('none');
  });

  it('(f) reserveLaunch opportunistically sweeps rows older than the TTL', () => {
    const db = getSessionDb();
    db.prepare(
      `INSERT INTO launch_reservations (launch_id, hosted_by, agent, cwd, expected_session_id, created_at)
       VALUES (?, ?, ?, ?, ?, datetime('now', '-2 day'))`,
    ).run('stale-launch', 'syntaurd', null, null, null);
    expect(getLaunchReservation('stale-launch')).not.toBeNull();

    reserveLaunch({ launchId: LAUNCH_ID, hostedBy: 'syntaurd', expectedSessionId: 'real-A' });

    expect(getLaunchReservation('stale-launch')).toBeNull();
    expect(getLaunchReservation(LAUNCH_ID)).not.toBeNull();
  });

  it('(g) claim-first integration, BOUND: the proven root always wins, regardless of arrival order; the loser stamps nothing (review r1 F1)', async () => {
    // Normal order: the root claims first.
    await insertPlaceholder(); // placeholder keyed to LAUNCH_ID
    reserveLaunch({ launchId: LAUNCH_ID, hostedBy: 'syntaurd', expectedSessionId: 'real-A' });
    process.env.SYNTAUR_LAUNCH_ID = LAUNCH_ID;
    process.env.SYNTAUR_HOSTED_BY = 'syntaurd';

    const won = await consumeLaunchMarkers('real-A');
    expect(won).toEqual({ hostedBy: 'syntaurd' });
    let all = await listAllSessions('');
    expect(all.find((s) => s.sessionId === 'real-A')).toBeDefined();
    expect(all.find((s) => s.sessionId === LAUNCH_ID)).toBeUndefined();

    const lost = await consumeLaunchMarkers('real-B');
    expect(lost).toEqual({});
    all = await listAllSessions('');
    expect(all.find((s) => s.sessionId === 'real-B')).toBeUndefined();

    // Intruder-FIRST order, on a fresh identical fixture: the intruder
    // arriving BEFORE the root must still lose and leave the placeholder
    // untouched; the root must still migrate normally when it arrives
    // later. SABOTAGE-VERIFIED locally (see Task 15 report): claimLaunch
    // enforces identity TWICE — a pre-check (`if (row.expected_session_id
    // !== realSessionId) return 'lost'`) and, redundantly, inside the CAS
    // UPDATE's WHERE (`AND expected_session_id = @real`). Each check is
    // independently sufficient for this scenario, so commenting out either
    // ONE alone does not fail this test — but commenting out BOTH does:
    // the intruder then wins the CAS and re-keys the placeholder onto
    // 'real-B2' instead of refusing. Verified all three combinations
    // locally, reverted; no sabotage code is committed.
    const OTHER_LAUNCH_ID = 'ffffffff-6666-4666-8666-ffffffffffff';
    await insertPlaceholder(OTHER_LAUNCH_ID);
    reserveLaunch({ launchId: OTHER_LAUNCH_ID, hostedBy: 'syntaurd', expectedSessionId: 'real-A2' });
    process.env.SYNTAUR_LAUNCH_ID = OTHER_LAUNCH_ID;

    const intruderFirst = await consumeLaunchMarkers('real-B2');
    expect(intruderFirst).toEqual({});
    all = await listAllSessions('');
    expect(all.find((s) => s.sessionId === OTHER_LAUNCH_ID)).toBeDefined(); // untouched
    expect(all.find((s) => s.sessionId === 'real-B2')).toBeUndefined();

    const rootAfter = await consumeLaunchMarkers('real-A2');
    expect(rootAfter).toEqual({ hostedBy: 'syntaurd' });
    all = await listAllSessions('');
    expect(all.find((s) => s.sessionId === 'real-A2')).toBeDefined();
    expect(all.find((s) => s.sessionId === OTHER_LAUNCH_ID)).toBeUndefined();
  });

  it('(g2) claim-first integration, UNBOUND: behaves exactly like today, and claimed_by stays NULL (review r2 F1, excluded mode)', async () => {
    await insertPlaceholder();
    reserveLaunch({ launchId: LAUNCH_ID, hostedBy: 'syntaurd' }); // no expectedSessionId
    process.env.SYNTAUR_LAUNCH_ID = LAUNCH_ID;
    process.env.SYNTAUR_HOSTED_BY = 'syntaurd';

    const markers = await consumeLaunchMarkers(REAL_ID);
    expect(markers).toEqual({ hostedBy: 'syntaurd' });
    const all = await listAllSessions('');
    expect(all.find((s) => s.sessionId === REAL_ID)).toBeDefined();
    expect(all.find((s) => s.sessionId === LAUNCH_ID)).toBeUndefined();
    expect(getLaunchReservation(LAUNCH_ID)?.claimedBy).toBeNull();
  });

  it('(h) a reservation alone produces no session row — no ghost sessions in the feed', async () => {
    reserveLaunch({ launchId: LAUNCH_ID, hostedBy: 'syntaurd', expectedSessionId: 'real-A' });
    const all = await listAllSessions('');
    expect(all.find((s) => s.sessionId === LAUNCH_ID)).toBeUndefined();
  });
});

// ── End-to-end: real db + real launchSyntaurd/registerRow/consumeLaunchMarkers
// composed together, fakes ONLY at the daemon-request seam (Phase C Task 17).
// This is AC8's proof that Phase B's residuals actually close when the real
// pieces run together, not just in isolation (T15/T16's unit-level coverage).
describe('pending-launch reservation — end to end (Phase C Task 17)', () => {
  const claudeAgent: AgentConfig = { id: 'claude', label: 'Claude', command: 'claude' };
  const claudeAliasAgent: AgentConfig = { ...claudeAgent, resolveFromShellAliases: true };
  const codexAgent: AgentConfig = { id: 'codex', label: 'Codex', command: 'codex' };
  const basePlan = { command: 'claude', args: ['hi'], cwd: '/w' };

  let prevRuntimeDir: string | undefined;
  beforeEach(() => {
    // The real (uninjected) findSession probe consults the daemon socket
    // pointer on every ambiguous-rejection path below (b1-b3, c, e) —
    // redirect it into the tmp home so these tests never brush against a
    // REAL syntaurd that happens to be running on this machine.
    prevRuntimeDir = process.env.SYNTAUR_RUNTIME_DIR;
    process.env.SYNTAUR_RUNTIME_DIR = resolve(testDir, 'runtime');
  });
  afterEach(() => {
    if (prevRuntimeDir === undefined) delete process.env.SYNTAUR_RUNTIME_DIR;
    else process.env.SYNTAUR_RUNTIME_DIR = prevRuntimeDir;
  });

  /** A durable jobs-dir record for the ambiguous-recovery poll — mirrors launch.test.ts's fixture. */
  function jobStateFixture(overrides: Partial<JobState> = {}): JobState {
    return {
      short: 'jjb1234',
      agent: 'codex',
      argv: ['codex', 'hi'],
      cwd: '/w',
      state: 'working',
      pid: 999,
      pidStartedAt: null,
      sessionId: 'b-fixed-id',
      cols: 80,
      rows: 24,
      createdAt: '2026-07-16T00:00:00.000Z',
      updatedAt: '2026-07-16T00:00:00.000Z',
      daemonId: 'd1',
      ptySock: '/tmp/jjb1234.pty.sock',
      rvSock: '/tmp/jjb1234.rv.sock',
      hostPid: process.pid,
      hostPidStartedAt: null,
      ...overrides,
    };
  }

  // sabotage-verified: commented out `pid = COALESCE(excluded.pid, pid)` in
  // appendSession's ON CONFLICT clause (session-db.ts's upsert). Row count
  // stayed 1 — session_id is a PRIMARY KEY, so a literal second row is
  // structurally impossible regardless — but the `pid` assertion below
  // failed (stayed NULL instead of 4242): launchSyntaurd's own registerRow
  // call could no longer fill it onto the hook's already-created row. The
  // guarantee this test actually isolates is the upsert's write-if-null
  // MERGE onto the same row, not the row count (which the schema already
  // guarantees). Restored after confirming; no sabotage code is committed.
  it('(a) hook-wins-race BOUND: the hook row and the launch placeholder are the SAME upsert target — exactly one row', async () => {
    const FIXED_ID = 'a-fixed-id';
    const request = vi.fn(async () => {
      // Simulates the agent's session-registration hook, which runs (and
      // completes) strictly before the daemon reply resolves — no timers.
      process.env.SYNTAUR_LAUNCH_ID = FIXED_ID;
      process.env.SYNTAUR_HOSTED_BY = 'syntaurd';
      const markers = await consumeLaunchMarkers(FIXED_ID); // REAL — Branch A, claims 'won'
      await appendSession('', {
        sessionId: FIXED_ID,
        agent: 'claude',
        started: '2026-07-16T00:00:00.000Z',
        status: 'active',
        path: '/w',
        projectSlug: null,
        assignmentSlug: null,
        ...markers,
      });
      return { ok: true as const, short: 's1', pid: 4242 };
    });

    await launchSyntaurd({
      plan: basePlan,
      name: 'proj/a1',
      agent: claudeAgent,
      projectSlug: 'proj',
      assignmentSlug: 'a1',
      request,
      generateSessionId: () => FIXED_ID,
    });

    const db = getSessionDb();
    const count = (db.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }).n;
    expect(count).toBe(1);
    const row = db.prepare('SELECT session_id, hosted_by, pid FROM sessions').get() as {
      session_id: string;
      hosted_by: string | null;
      pid: number | null;
    };
    expect(row.session_id).toBe(FIXED_ID);
    expect(row.hosted_by).toBe('syntaurd');
    expect(row.pid).toBe(4242);
  });

  it('(a2) hook-wins-race UNBOUND (shell-alias): the documented OPEN residual — two rows, claimed_by stays NULL (review r2 F1, excluded mode)', async () => {
    const FIXED_ID = 'a2-fixed-id';
    const REAL_CLAUDE_ID = 'a2-real-claude-id';
    const request = vi.fn(async () => {
      process.env.SYNTAUR_LAUNCH_ID = FIXED_ID;
      process.env.SYNTAUR_HOSTED_BY = 'syntaurd';
      // The hook id (from the launch) differs from the real registration id:
      // a shell-alias claude generates its OWN session id, never told the
      // cockpit's launch id via --session-id (canInjectClaudeSessionId is false).
      const markers = await consumeLaunchMarkers(REAL_CLAUDE_ID);
      await appendSession('', {
        sessionId: REAL_CLAUDE_ID,
        agent: 'claude',
        started: '2026-07-16T00:00:00.000Z',
        status: 'active',
        path: '/w',
        projectSlug: null,
        assignmentSlug: null,
        ...markers,
      });
      return { ok: true as const, short: 's2', pid: 4343 };
    });

    await launchSyntaurd({
      plan: { command: '/bin/zsh', args: ['-i', '-c', "claude 'hi'"], cwd: '/w' },
      name: 'proj/a1',
      agent: claudeAliasAgent, // non-injectable — expectedSessionId is null (unbound)
      projectSlug: 'proj',
      assignmentSlug: 'a1',
      request,
      generateSessionId: () => FIXED_ID,
    });

    const all = await listAllSessions('');
    expect(all).toHaveLength(2); // the documented, deliberately-open residual

    const placeholder = all.find((s) => s.sessionId === FIXED_ID);
    expect(placeholder).toBeDefined();
    expect(placeholder?.pid).toBe(4343); // pty-host pid — the self-heal signal for the scanner sweep
    expect(placeholder?.hostedBy).toBe('syntaurd');

    const real = all.find((s) => s.sessionId === REAL_CLAUDE_ID);
    expect(real).toBeDefined();
    expect(real?.pid).toBeNull(); // untouched — the hook never learns the daemon pid

    expect(getLaunchReservation(FIXED_ID)?.claimedBy).toBeNull();
  });

  // sabotage-verified: commented out the entire jobs-dir poll `for` loop in
  // launchSyntaurd (launch.ts — the `readJobs()` / hostIdentity scan block
  // inside the ambiguous-rejection catch). This test's real writeJobState
  // evidence was then never consulted: launchSyntaurd rejected with the
  // original dispatch error instead of resolving, and zero rows were
  // registered. Restored after confirming; no sabotage code is committed.
  it('(b1) daemon-death ambiguity: real jobs-dir evidence with a live host adopts — no double row, reservation stays uncanceled', async () => {
    const FIXED_ID = 'b1-fixed-id';
    writeJobState(jobStateFixture({ sessionId: FIXED_ID, hostPid: process.pid, hostPidStartedAt: null }));

    const result = await launchSyntaurd({
      plan: { command: 'codex', args: ['hi'], cwd: '/w' },
      name: 'proj/a1',
      agent: codexAgent,
      projectSlug: 'proj',
      assignmentSlug: 'a1',
      request: vi.fn(async () => {
        throw new Error('socket hang up');
      }),
      generateSessionId: () => FIXED_ID,
    });

    expect(result).toEqual({ short: 'jjb1234', sessionId: FIXED_ID, registered: true });
    const all = await listAllSessions('');
    expect(all.filter((s) => s.sessionId === FIXED_ID)).toHaveLength(1);
    expect(all.find((s) => s.sessionId === FIXED_ID)?.pid).toBe(process.pid);
    expect(getLaunchReservation(FIXED_ID)?.canceledAt).toBeNull();
  });

  it('(b2) daemon-death ambiguity: nothing landed (no job state) → degrades and cancels the reservation, zero rows', async () => {
    const FIXED_ID = 'b2-fixed-id';
    const err = new Error('socket hang up');

    await expect(
      launchSyntaurd({
        plan: { command: 'codex', args: ['hi'], cwd: '/w' },
        name: 'proj/a1',
        agent: codexAgent,
        projectSlug: 'proj',
        assignmentSlug: 'a1',
        request: vi.fn(async () => {
          throw err;
        }),
        generateSessionId: () => FIXED_ID,
      }),
    ).rejects.toThrow(err);

    expect(getLaunchReservation(FIXED_ID)?.canceledAt).toBeTruthy();
    const all = await listAllSessions('');
    expect(all.filter((s) => s.sessionId === FIXED_ID)).toHaveLength(0);
  });

  it('(b3) daemon-death ambiguity: a DEAD host pid in the jobs dir is not adopted — degrades and cancels, zero rows (review r2 F2)', async () => {
    const FIXED_ID = 'b3-fixed-id';
    const err = new Error('socket hang up');
    writeJobState(jobStateFixture({ sessionId: FIXED_ID, hostPid: 999999999, hostPidStartedAt: null }));

    await expect(
      launchSyntaurd({
        plan: { command: 'codex', args: ['hi'], cwd: '/w' },
        name: 'proj/a1',
        agent: codexAgent,
        projectSlug: 'proj',
        assignmentSlug: 'a1',
        request: vi.fn(async () => {
          throw err;
        }),
        generateSessionId: () => FIXED_ID,
      }),
    ).rejects.toThrow(err);

    expect(getLaunchReservation(FIXED_ID)?.canceledAt).toBeTruthy();
    const all = await listAllSessions('');
    expect(all.filter((s) => s.sessionId === FIXED_ID)).toHaveLength(0);
  });

  it('(c) failed dispatch cancels the reservation; an immediate retry of a NEW identity succeeds, and retrying the SAME identity revives the canceled row (requirement 4, claim-protected)', async () => {
    const FAIL_ID = 'c-fail-id';
    await expect(
      launchSyntaurd({
        plan: basePlan,
        name: 'proj/a1',
        agent: claudeAgent,
        projectSlug: 'proj',
        assignmentSlug: 'a1',
        request: vi.fn(async () => ({ ok: false as const, code: 'EEMPTYARGV', error: 'boom' })),
        generateSessionId: () => FAIL_ID,
      }),
    ).rejects.toThrow(/daemon dispatch failed/);
    expect(getLaunchReservation(FAIL_ID)?.canceledAt).toBeTruthy();
    expect((await listAllSessions('')).find((s) => s.sessionId === FAIL_ID)).toBeUndefined();

    // Immediate retry with a fresh identity: unaffected by the prior failure.
    const NEW_ID = 'c-new-id';
    const result = await launchSyntaurd({
      plan: basePlan,
      name: 'proj/a1',
      agent: claudeAgent,
      projectSlug: 'proj',
      assignmentSlug: 'a1',
      request: vi.fn(async () => ({ ok: true as const, short: 'ccnew1', pid: 5151 })),
      generateSessionId: () => NEW_ID,
    });
    expect(result).toEqual({ short: 'ccnew1', sessionId: NEW_ID, registered: true });
    expect((await listAllSessions('')).filter((s) => s.sessionId === NEW_ID)).toHaveLength(1);

    // Same-identity variant: fail under a fresh id, then retry THAT SAME id —
    // reserveLaunch must revive the canceled row rather than refuse it.
    const SAME_ID = 'c-same-id';
    await expect(
      launchSyntaurd({
        plan: basePlan,
        name: 'proj/a1',
        agent: claudeAgent,
        projectSlug: 'proj',
        assignmentSlug: 'a1',
        request: vi.fn(async () => ({ ok: false as const, code: 'EEMPTYARGV', error: 'boom' })),
        generateSessionId: () => SAME_ID,
      }),
    ).rejects.toThrow(/daemon dispatch failed/);
    expect(getLaunchReservation(SAME_ID)?.canceledAt).toBeTruthy();

    const result2 = await launchSyntaurd({
      plan: basePlan,
      name: 'proj/a1',
      agent: claudeAgent,
      projectSlug: 'proj',
      assignmentSlug: 'a1',
      request: vi.fn(async () => ({ ok: true as const, short: 'ccsame1', pid: 6161 })),
      generateSessionId: () => SAME_ID,
    });
    expect(result2).toEqual({ short: 'ccsame1', sessionId: SAME_ID, registered: true });
    const revived = getLaunchReservation(SAME_ID);
    expect(revived?.canceledAt).toBeNull();
    expect(revived?.claimedBy).toBeNull();
    expect(revived?.expectedSessionId).toBe(SAME_ID); // reserveLaunch REVIVED the canceled row
  });

  it('(d) a reservation with no dispatch never surfaces in the feed or rail', async () => {
    const ok = reserveLaunch({
      launchId: 'd-launch-id',
      hostedBy: 'syntaurd',
      agent: 'claude',
      cwd: '/w',
      expectedSessionId: 'd-launch-id',
    });
    expect(ok).toBe(true);

    const sessions = await loadSessions({
      projectsDir: '',
      agents: [claudeAgent],
      livenessDeps: { isPidAlive: () => true, pidStartedAt: () => null },
      agentViewDetailSource: async () => [],
      syntaurdSessionSource: async () => [],
    });
    expect(sessions).toEqual([]); // reservations are never sessions rows

    const rows = buildRailRows(sessions, { recentExpanded: true });
    expect(rows.every((r) => r.kind === 'group-header')).toBe(true);
    expect(rows).toHaveLength(2); // LIVE (0) + RECENT (0) headers only
  });

  it('(e) the TTL sweep runs on the real launchSyntaurd path, removing an abandoned reservation', async () => {
    const db = getSessionDb();
    db.prepare(
      `INSERT INTO launch_reservations (launch_id, hosted_by, agent, cwd, expected_session_id, created_at)
       VALUES (?, ?, ?, ?, ?, datetime('now', '-2 day'))`,
    ).run('e-stale-launch', 'syntaurd', null, null, null);
    expect(getLaunchReservation('e-stale-launch')).not.toBeNull();

    await launchSyntaurd({
      plan: { command: 'codex', args: ['hi'], cwd: '/w' },
      name: 'proj/a1',
      agent: codexAgent,
      projectSlug: 'proj',
      assignmentSlug: 'a1',
      request: vi.fn(async () => ({ ok: true as const, short: 'eeok1', pid: 7171 })),
      generateSessionId: () => 'e-launch-id',
    });

    expect(getLaunchReservation('e-stale-launch')).toBeNull();
  });

  it('(f1) intruder-AFTER: a subagent/track-session claim arriving after the root is refused — root row untouched, no stamp for the intruder (review r1 F1)', async () => {
    const FIXED_ID = 'f1-fixed-id';
    await insertPlaceholder(FIXED_ID); // pristine placeholder — never claimed
    reserveLaunch({
      launchId: FIXED_ID,
      hostedBy: 'syntaurd',
      agent: 'claude',
      cwd: '/w/a',
      expectedSessionId: FIXED_ID,
    });
    process.env.SYNTAUR_LAUNCH_ID = FIXED_ID;
    process.env.SYNTAUR_HOSTED_BY = 'syntaurd';

    // The root's real session id IS the launch id (Branch A --session-id
    // injection) — reconcile no-ops (already at the target id) and the claim wins.
    const rootMarkers = await consumeLaunchMarkers(FIXED_ID);
    expect(rootMarkers).toEqual({ hostedBy: 'syntaurd' });
    expect(getLaunchReservation(FIXED_ID)?.claimedBy).toBe(FIXED_ID);

    // A subagent hook / `track-session --session-id <other>` inherits the SAME
    // env and arrives AFTER the root.
    const intruderMarkers = await consumeLaunchMarkers('f1-intruder-id');
    expect(intruderMarkers).toEqual({}); // refused — no backend stamp
    await appendSession('', {
      sessionId: 'f1-intruder-id',
      agent: 'claude',
      started: '2026-07-16T00:01:00.000Z',
      status: 'active',
      path: '/w/b',
      projectSlug: null,
      assignmentSlug: null,
      ...intruderMarkers,
    });

    const all = await listAllSessions('');
    expect(all).toHaveLength(2); // ROW COUNT: root + the intruder's own unrelated row — nothing stolen
    const root = all.find((s) => s.sessionId === FIXED_ID);
    expect(root).toBeDefined();
    expect(root?.hostedBy).toBe('syntaurd');
    expect(root?.pid).toBe(4242); // insertPlaceholder's fixture pid, untouched
    const intruder = all.find((s) => s.sessionId === 'f1-intruder-id');
    expect(intruder).toBeDefined();
    expect(intruder?.hostedBy).toBeNull(); // no stamp — the claim was refused
    expect(countKeyedTo(FIXED_ID).engagement).toBe(1); // the root's engagement never moved
  });

  // sabotage-verified: dropping ONLY claimLaunch's pre-check
  // (`if (row.expected_session_id !== realSessionId) return 'lost';`) does
  // NOT fail this test — the CAS UPDATE's WHERE clause independently
  // enforces the same identity match (the same double-guard Task 15 already
  // documented at case (g) above). Dropping BOTH the pre-check AND the CAS
  // WHERE's `AND expected_session_id = @real` DOES fail it: the intruder's
  // claim then reads 'won', consumeLaunchMarkers reconciles the placeholder
  // onto 'f2-intruder-id', and the root's later claim reads 'lost' — the
  // root loses its own launch. Verified both combinations locally, reverted
  // after confirming; no sabotage code is committed.
  it('(f2) intruder-FIRST: a claim arriving before the root still loses — the root still wins arriving second (review r1 F1)', async () => {
    const FIXED_ID = 'f2-fixed-id';
    await insertPlaceholder(FIXED_ID);
    reserveLaunch({
      launchId: FIXED_ID,
      hostedBy: 'syntaurd',
      agent: 'claude',
      cwd: '/w/a',
      expectedSessionId: FIXED_ID,
    });
    process.env.SYNTAUR_LAUNCH_ID = FIXED_ID;
    process.env.SYNTAUR_HOSTED_BY = 'syntaurd';

    const intruderMarkers = await consumeLaunchMarkers('f2-intruder-id');
    expect(intruderMarkers).toEqual({});
    expect(getLaunchReservation(FIXED_ID)?.claimedBy).toBeNull(); // still unclaimed
    let all = await listAllSessions('');
    expect(all.find((s) => s.sessionId === FIXED_ID)).toBeDefined(); // placeholder untouched
    expect(all.find((s) => s.sessionId === 'f2-intruder-id')).toBeUndefined(); // no row for the refused intruder

    const rootMarkers = await consumeLaunchMarkers(FIXED_ID);
    expect(rootMarkers).toEqual({ hostedBy: 'syntaurd' });
    expect(getLaunchReservation(FIXED_ID)?.claimedBy).toBe(FIXED_ID);

    all = await listAllSessions('');
    expect(all).toHaveLength(1); // ROW COUNT: only the root's row
    const root = all.find((s) => s.sessionId === FIXED_ID);
    expect(root).toBeDefined();
    expect(root?.hostedBy).toBe('syntaurd');
  });
});
