import { Router } from 'express';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileExists } from '../utils/fs.js';
import { extractFrontmatter, getField } from './parser.js';
import { resolveTicketById } from '../utils/ticket-resolver.js';
import {
  initEventsDb,
  listEventsByAssignment,
  type EventRow,
  type ListEventsFilters,
} from '../db/events-db.js';

/**
 * Read-only per-ticket events (Activity timeline) API. Localhost-only per
 * the existing dashboard convention (no auth). Mirrors `api-usage.ts`'s router
 * shape.
 *
 * Endpoint:
 *   GET /api/tickets/:id/events — project-nested or standalone (UUID-keyed)
 *
 * Resolves the ticket's frontmatter `id` (the key the events table is indexed
 * by), `initEventsDb()`, and returns `{ events }` newest-first with each row's
 * `details` JSON string parsed into an object.
 *
 * BEST-EFFORT: on ANY error (DB missing, ticket not found, parse failure) this
 * returns `{ events: [] }` and never 500s — a failed events fetch must not
 * break the ticket detail page (see Task F).
 */
export function createEventsRouter(
  projectsDir: string,
  ticketsDir: string,
): Router {
  const router = Router();

  router.get('/tickets/:id/events', async (req, res) => {
    try {
      const { id } = req.params;
      const resolved = await resolveTicketById(projectsDir, ticketsDir, id);
      if (!resolved) {
        res.json({ events: [] });
        return;
      }
      const ticketMdPath = resolve(resolved.ticketDir, 'ticket.md');
      const ticketId = (await readTicketId(ticketMdPath)) ?? resolved.id;
      res.json({ events: loadEvents(ticketId, req.query) });
    } catch (error) {
      console.warn('[events] failed to list ticket events:', error);
      res.json({ events: [] });
    }
  });

  return router;
}

/** Read a ticket.md's frontmatter `id`. Returns null when missing/unreadable. */
async function readTicketId(ticketMdPath: string): Promise<string | null> {
  if (!(await fileExists(ticketMdPath))) return null;
  const content = await readFile(ticketMdPath, 'utf-8');
  const [fm] = extractFrontmatter(content);
  const id = getField(fm, 'id');
  return id && id.length > 0 ? id : null;
}

/**
 * Query the events DB for a ticket id and shape the rows for the API:
 * newest-first (the DB query already orders `at DESC`) with each `details` JSON
 * string parsed into an object (or null when absent/invalid).
 */
function loadEvents(
  ticketId: string,
  query: Record<string, unknown>,
): Array<Omit<EventRow, 'details'> & { details: unknown }> {
  initEventsDb();
  const rows = listEventsByAssignment(ticketId, parseFilters(query));
  return rows.map((row) => ({
    ...row,
    details: parseDetails(row.details),
  }));
}

/** Parse a stored `details` JSON string into an object; null on absent/invalid. */
function parseDetails(details: string | null): unknown {
  if (!details) return null;
  try {
    return JSON.parse(details);
  } catch {
    return null;
  }
}

/** Translate `?since=&types=&limit=` query params into a `ListEventsFilters`. */
function parseFilters(query: Record<string, unknown>): ListEventsFilters {
  const out: ListEventsFilters = {};
  if (typeof query.since === 'string' && query.since.length > 0) {
    out.since = query.since;
  }
  if (typeof query.types === 'string' && query.types.length > 0) {
    out.types = query.types.split(',').map((t) => t.trim()).filter(Boolean);
  }
  if (typeof query.limit === 'string') {
    const n = Number(query.limit);
    if (Number.isInteger(n) && n > 0) out.limit = n;
  }
  return out;
}
