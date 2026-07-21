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
  reserveLaunch,
  markLaunchDispatched,
  claimLaunch,
  cancelLaunch,
  getLaunchReservation,
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
