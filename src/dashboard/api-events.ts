import { Router } from 'express';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileExists } from '../utils/fs.js';
import { extractFrontmatter, getField } from './parser.js';
import {
  initEventsDb,
  listEventsByAssignment,
  type EventRow,
  type ListEventsFilters,
} from '../db/events-db.js';

/**
 * Read-only per-assignment events (Activity timeline) API. Localhost-only per
 * the existing dashboard convention (no auth). Mirrors `api-usage.ts`'s router
 * shape.
 *
 * Endpoints:
 *   GET /api/projects/:slug/tickets/:aslug/events  — project-nested assignment
 *   GET /api/standalone/tickets/:id/events          — standalone (UUID-keyed)
 *
 * Both resolve the assignment's frontmatter `id` (the key the events table is
 * indexed by), `initEventsDb()`, and return `{ events }` newest-first with each
 * row's `details` JSON string parsed into an object.
 *
 * BEST-EFFORT: on ANY error (DB missing, assignment not found, parse failure)
 * this returns `{ events: [] }` and never 500s — a failed events fetch must not
 * break the assignment detail page (see Task F).
 */
export function createEventsRouter(
  projectsDir: string,
  ticketsDir: string,
): Router {
  const router = Router();

  // Project-nested: resolve <projectsDir>/<slug>/tickets/<aslug>/assignment.md → frontmatter id.
  router.get('/projects/:slug/tickets/:aslug/events', async (req, res) => {
    try {
      const { slug, aslug } = req.params;
      const assignmentMdPath = resolve(
        projectsDir,
        slug,
        'tickets',
        aslug,
        'ticket.md',
      );
      const id = await readAssignmentId(assignmentMdPath);
      if (!id) {
        res.json({ events: [] });
        return;
      }
      res.json({ events: loadEvents(id, req.query) });
    } catch (error) {
      console.warn('[events] failed to list project-nested events:', error);
      res.json({ events: [] });
    }
  });

  // Standalone: the `:id` param IS the UUID directory name. Re-read the
  // frontmatter `id` (which equals the directory) so the DB key is canonical.
  router.get('/standalone/tickets/:id/events', async (req, res) => {
    try {
      const { id: dirId } = req.params;
      const assignmentMdPath = resolve(ticketsDir, dirId, 'ticket.md');
      const id = (await readAssignmentId(assignmentMdPath)) ?? dirId;
      res.json({ events: loadEvents(id, req.query) });
    } catch (error) {
      console.warn('[events] failed to list standalone events:', error);
      res.json({ events: [] });
    }
  });

  return router;
}

/** Read an assignment.md's frontmatter `id`. Returns null when missing/unreadable. */
async function readAssignmentId(assignmentMdPath: string): Promise<string | null> {
  if (!(await fileExists(assignmentMdPath))) return null;
  const content = await readFile(assignmentMdPath, 'utf-8');
  const [fm] = extractFrontmatter(content);
  const id = getField(fm, 'id');
  return id && id.length > 0 ? id : null;
}

/**
 * Query the events DB for an assignment id and shape the rows for the API:
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
