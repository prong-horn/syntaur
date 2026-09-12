import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import {
  initSessionDb,
  closeSessionDb,
  resetSessionDb,
} from '../dashboard/session-db.js';
import { getEngagementsByTicketId } from '../db/engagement-db.js';

let sandbox: string;
let dbPath: string;

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'syntaur-engagement-by-ticket-'));
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
    ticketId: string;
    stage: string;
    started: string;
    ended?: string | null;
  },
) {
  db.prepare(
    `INSERT INTO engagement (session_id, ticket_id, stage, started_at, ended_at)
     VALUES (@sessionId, @ticketId, @stage, @started, @ended)`,
  ).run({
    sessionId: e.sessionId,
    ticketId: e.ticketId,
    stage: e.stage,
    started: e.started,
    ended: e.ended ?? null,
  });
}

describe('getEngagementsByTicketId', () => {
  it('returns all engagements for the ticket ordered by started_at (regardless of insert/id order)', () => {
    const db = initSessionDb(dbPath);
    // Insert out of chronological order to prove sorting is by started_at, not id.
    seedEngagement(db, {
      sessionId: 'sess-2',
      ticketId: 'ASN-1',
      stage: 'implement',
      started: '2026-06-26T11:00:00.000Z',
      ended: '2026-06-26T12:00:00.000Z',
    }); // id 1
    seedEngagement(db, {
      sessionId: 'sess-1',
      ticketId: 'ASN-1',
      stage: 'plan',
      started: '2026-06-26T10:00:00.000Z',
      ended: '2026-06-26T10:30:00.000Z',
    }); // id 2
    seedEngagement(db, {
      sessionId: 'sess-2',
      ticketId: 'ASN-1',
      stage: 'review',
      started: '2026-06-26T12:00:00.000Z',
      ended: null,
    }); // id 3 — open (sess-2's only open row)

    const rows = getEngagementsByTicketId('ASN-1');

    expect(rows.map((r) => r.stage)).toEqual(['plan', 'implement', 'review']);
    expect(rows.map((r) => r.session_id)).toEqual(['sess-1', 'sess-2', 'sess-2']);
  });

  it('breaks started_at ties by id (insertion order)', () => {
    const db = initSessionDb(dbPath);
    const sameStart = '2026-06-26T09:00:00.000Z';
    seedEngagement(db, {
      sessionId: 'sess-a',
      ticketId: 'ASN-2',
      stage: 'plan',
      started: sameStart,
      ended: sameStart,
    }); // id 1
    seedEngagement(db, {
      sessionId: 'sess-b',
      ticketId: 'ASN-2',
      stage: 'implement',
      started: sameStart,
      ended: sameStart,
    }); // id 2

    const rows = getEngagementsByTicketId('ASN-2');

    // Equal started_at → rows come back in id (insertion) order, not reversed.
    expect(rows.map((r) => r.session_id)).toEqual(['sess-a', 'sess-b']);
    expect(rows[0].id).toBeLessThan(rows[1].id);
  });

  it('returns an open engagement with ended_at null', () => {
    const db = initSessionDb(dbPath);
    seedEngagement(db, {
      sessionId: 'sess-open',
      ticketId: 'ASN-3',
      stage: 'implement',
      started: '2026-06-26T08:00:00.000Z',
      ended: null,
    });

    const rows = getEngagementsByTicketId('ASN-3');

    expect(rows).toHaveLength(1);
    expect(rows[0].ended_at).toBeNull();
  });

  it('excludes engagements belonging to other tickets', () => {
    const db = initSessionDb(dbPath);
    seedEngagement(db, {
      sessionId: 'sess-1',
      ticketId: 'ASN-1',
      stage: 'plan',
      started: '2026-06-26T10:00:00.000Z',
      ended: '2026-06-26T10:30:00.000Z',
    });
    seedEngagement(db, {
      sessionId: 'sess-3',
      ticketId: 'OTH-1',
      stage: 'implement',
      started: '2026-06-26T10:15:00.000Z',
      ended: null,
    });

    const rows = getEngagementsByTicketId('ASN-1');

    expect(rows).toHaveLength(1);
    expect(rows.every((r) => r.ticket_id === 'ASN-1')).toBe(true);
  });

  it('returns an empty array for an unknown ticket id', () => {
    initSessionDb(dbPath);
    expect(getEngagementsByTicketId('does-not-exist')).toEqual([]);
  });
});
