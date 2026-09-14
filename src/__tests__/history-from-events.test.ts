import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  deriveStatusVirtualsFromEvents,
  deriveStatusVirtualsForTicket,
  loadTicketHistoryMaps,
  statusTimestampFromEvents,
} from '../lifecycle/history-from-events.js';
import {
  initEventsDb,
  resetEventsDb,
  closeEventsDb,
  recordEvent,
  latestMovesByTicket,
} from '../db/events-db.js';

let dbPath: string;

beforeEach(async () => {
  closeEventsDb();
  dbPath = join(await mkdtemp(join(tmpdir(), 'syntaur-events-')), 'syntaur.db');
  initEventsDb(dbPath);
});

afterEach(async () => {
  closeEventsDb();
  resetEventsDb();
  if (dbPath) {
    await rm(join(dbPath, '..'), { recursive: true, force: true });
  }
});

describe('history-from-events', () => {
  it('statusTimestampFromEvents prefers move over created over updated', () => {
    expect(
      statusTimestampFromEvents(
        { at: '2026-04-01T12:00:00Z', from: 'backlog', to: 'planning' },
        '2026-03-01T00:00:00Z',
        '2026-03-15T00:00:00Z',
      ),
    ).toBe('2026-04-01T12:00:00Z');
    expect(statusTimestampFromEvents(undefined, '2026-03-01T00:00:00Z', '2026-03-15T00:00:00Z')).toBe(
      '2026-03-01T00:00:00Z',
    );
  });

  it('deriveStatusVirtualsFromEvents sets completedAt only for terminal moves', () => {
    const now = Date.parse('2026-04-02T00:00:00Z');
    const move = { at: '2026-04-01T12:00:00Z', from: 'review', to: 'done' };
    const terminal = deriveStatusVirtualsFromEvents('done', '2026-03-01T00:00:00Z', move, undefined, now);
    expect(terminal.completedAt).toBe('2026-04-01T12:00:00Z');
    expect(terminal.statusAge).toBe(12 * 60 * 60 * 1000);

    const nonTerminal = deriveStatusVirtualsFromEvents('review', '2026-03-01T00:00:00Z', move, undefined, now);
    expect(nonTerminal.completedAt).toBeNull();
  });

  it('latestMovesByTicket returns the newest moved event per ticket', () => {
    recordEvent({
      ticketId: 't-1',
      type: 'moved',
      actor: 'agent',
      at: '2026-04-01T10:00:00Z',
      details: { from: 'backlog', to: 'planning' },
    });
    recordEvent({
      ticketId: 't-1',
      type: 'moved',
      actor: 'agent',
      at: '2026-04-01T12:00:00Z',
      details: { from: 'planning', to: 'implementing' },
    });
    const moves = latestMovesByTicket(['t-1']);
    expect(moves.get('t-1')).toMatchObject({ to: 'implementing', at: '2026-04-01T12:00:00Z' });
  });

  it('loadTicketHistoryMaps + deriveStatusVirtualsForTicket batch-derive virtuals', () => {
    recordEvent({
      ticketId: 't-2',
      type: 'created',
      actor: 'human',
      at: '2026-04-01T08:00:00Z',
      details: { to: 'backlog' },
    });
    const maps = loadTicketHistoryMaps(['t-2']);
    const virtuals = deriveStatusVirtualsForTicket(
      { id: 't-2', status: 'backlog', updated: '2026-04-01T08:00:00Z' },
      maps,
      Date.parse('2026-04-01T10:00:00Z'),
    );
    expect(virtuals.statusAge).toBe(2 * 60 * 60 * 1000);
    expect(virtuals.completedAt).toBeNull();
  });
});
