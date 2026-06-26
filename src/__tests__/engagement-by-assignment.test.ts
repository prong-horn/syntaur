import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import {
  initSessionDb,
  closeSessionDb,
  resetSessionDb,
} from '../dashboard/session-db.js';
import { getEngagementsByAssignmentId } from '../db/engagement-db.js';

let sandbox: string;
let dbPath: string;

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'syntaur-engagement-by-assignment-'));
  dbPath = resolve(sandbox, 'syntaur.db');
  resetSessionDb();
});

afterEach(async () => {
  closeSessionDb();
  await rm(sandbox, { recursive: true, force: true });
});

type Db = ReturnType<typeof initSessionDb>;

// Insert one engagement interval. Only the columns the query reads/sorts on are
// set; the rest default (id autoincrements in insertion order). No session row
// is needed — `engagement` has no FK to `sessions`. Respect the
// `one_active_per_session` partial unique index: at most one open (ended=null)
// row per session_id.
function seedEngagement(
  db: Db,
  e: {
    sessionId: string;
    assignmentId: string;
    stage: string;
    started: string;
    ended?: string | null;
  },
) {
  db.prepare(
    `INSERT INTO engagement (session_id, assignment_id, stage, started_at, ended_at)
     VALUES (@sessionId, @assignmentId, @stage, @started, @ended)`,
  ).run({
    sessionId: e.sessionId,
    assignmentId: e.assignmentId,
    stage: e.stage,
    started: e.started,
    ended: e.ended ?? null,
  });
}

describe('getEngagementsByAssignmentId', () => {
  it('returns all engagements for the assignment ordered by started_at (regardless of insert/id order)', () => {
    const db = initSessionDb(dbPath);
    // Insert out of chronological order to prove sorting is by started_at, not id.
    seedEngagement(db, {
      sessionId: 'sess-2',
      assignmentId: 'asgn-A',
      stage: 'implement',
      started: '2026-06-26T11:00:00.000Z',
      ended: '2026-06-26T12:00:00.000Z',
    }); // id 1
    seedEngagement(db, {
      sessionId: 'sess-1',
      assignmentId: 'asgn-A',
      stage: 'plan',
      started: '2026-06-26T10:00:00.000Z',
      ended: '2026-06-26T10:30:00.000Z',
    }); // id 2
    seedEngagement(db, {
      sessionId: 'sess-2',
      assignmentId: 'asgn-A',
      stage: 'review',
      started: '2026-06-26T12:00:00.000Z',
      ended: null,
    }); // id 3 — open (sess-2's only open row)

    const rows = getEngagementsByAssignmentId('asgn-A');

    expect(rows.map((r) => r.stage)).toEqual(['plan', 'implement', 'review']);
    expect(rows.map((r) => r.session_id)).toEqual(['sess-1', 'sess-2', 'sess-2']);
  });

  it('breaks started_at ties by id (insertion order)', () => {
    const db = initSessionDb(dbPath);
    const sameStart = '2026-06-26T09:00:00.000Z';
    seedEngagement(db, {
      sessionId: 'sess-a',
      assignmentId: 'asgn-tie',
      stage: 'plan',
      started: sameStart,
      ended: sameStart,
    }); // id 1
    seedEngagement(db, {
      sessionId: 'sess-b',
      assignmentId: 'asgn-tie',
      stage: 'implement',
      started: sameStart,
      ended: sameStart,
    }); // id 2

    const rows = getEngagementsByAssignmentId('asgn-tie');

    expect(rows.map((r) => r.id)).toEqual([...rows.map((r) => r.id)].sort((a, b) => a - b));
    expect(rows.map((r) => r.session_id)).toEqual(['sess-a', 'sess-b']);
  });

  it('returns an open engagement with ended_at null', () => {
    const db = initSessionDb(dbPath);
    seedEngagement(db, {
      sessionId: 'sess-open',
      assignmentId: 'asgn-open',
      stage: 'implement',
      started: '2026-06-26T08:00:00.000Z',
      ended: null,
    });

    const rows = getEngagementsByAssignmentId('asgn-open');

    expect(rows).toHaveLength(1);
    expect(rows[0].ended_at).toBeNull();
  });

  it('excludes engagements belonging to other assignments', () => {
    const db = initSessionDb(dbPath);
    seedEngagement(db, {
      sessionId: 'sess-1',
      assignmentId: 'asgn-A',
      stage: 'plan',
      started: '2026-06-26T10:00:00.000Z',
      ended: '2026-06-26T10:30:00.000Z',
    });
    seedEngagement(db, {
      sessionId: 'sess-3',
      assignmentId: 'asgn-OTHER',
      stage: 'implement',
      started: '2026-06-26T10:15:00.000Z',
      ended: null,
    });

    const rows = getEngagementsByAssignmentId('asgn-A');

    expect(rows).toHaveLength(1);
    expect(rows.every((r) => r.assignment_id === 'asgn-A')).toBe(true);
  });

  it('returns an empty array for an unknown assignment id', () => {
    initSessionDb(dbPath);
    expect(getEngagementsByAssignmentId('does-not-exist')).toEqual([]);
  });
});
