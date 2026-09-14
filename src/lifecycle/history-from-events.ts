import {
  latestCreatedByTicket,
  latestMovesByTicket,
  type LatestMove,
} from '../db/events-db.js';
import { isTerminalStage } from '../ticket-templates/stages.js';

export interface StatusHistoryVirtuals {
  completedAt: string | null;
  statusAge: number | null;
}

function parseTimestampMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

export function statusTimestampFromEvents(
  move: LatestMove | undefined,
  createdAt: string | undefined,
  updated: string,
): string | null {
  return move?.at ?? createdAt ?? updated ?? null;
}

export function deriveStatusVirtualsFromEvents(
  status: string,
  updated: string,
  move: LatestMove | undefined,
  createdAt: string | undefined,
  now = Date.now(),
): StatusHistoryVirtuals {
  const anchor = statusTimestampFromEvents(move, createdAt, updated);
  const anchorMs = parseTimestampMs(anchor);
  const statusAge = anchorMs === null ? null : Math.max(0, now - anchorMs);

  const completedAt =
    isTerminalStage(status as Parameters<typeof isTerminalStage>[0]) && move?.to === status
      ? move.at
      : null;

  return {
    completedAt,
    statusAge,
  };
}

/** Batch-load move + created maps for many tickets (two queries). */
export function loadTicketHistoryMaps(ticketIds: string[]): {
  moves: Map<string, LatestMove>;
  created: Map<string, string>;
} {
  return {
    moves: latestMovesByTicket(ticketIds),
    created: latestCreatedByTicket(ticketIds),
  };
}

export function deriveStatusVirtualsForTicket(
  ticket: { id: string; status: string; updated: string },
  maps: { moves: Map<string, LatestMove>; created: Map<string, string> },
  now = Date.now(),
): StatusHistoryVirtuals {
  return deriveStatusVirtualsFromEvents(
    ticket.status,
    ticket.updated,
    maps.moves.get(ticket.id),
    maps.created.get(ticket.id),
    now,
  );
}
