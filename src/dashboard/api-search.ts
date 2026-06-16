import { Router } from 'express';
import {
  getIndex,
  resolveProvider,
  parseFileKinds,
  type FileKind,
  type SearchQuery,
} from '../search/index.js';

/** Hard cap on `limit` so a hostile/runaway query can't ask for an unbounded result set. */
const MAX_LIMIT = 50;
const DEFAULT_LIMIT = 20;

/** Read a query param as a single string (Express may hand back string | string[] | ParsedQs). */
function asString(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return undefined;
}

/** Split a comma-separated query param into a trimmed, non-empty string[] (undefined when absent/blank). */
function asCsv(value: unknown): string[] | undefined {
  const raw = asString(value);
  if (raw === undefined) return undefined;
  const parts = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return parts.length > 0 ? parts : undefined;
}

/** Truthy interpretation of a flag-style query param (`?all=1`, `?all=true`, bare `?all`). */
function isTruthy(value: unknown): boolean {
  const raw = asString(value);
  if (raw === undefined) return false;
  const normalized = raw.trim().toLowerCase();
  return normalized === '' || normalized === '1' || normalized === 'true' || normalized === 'yes';
}

/**
 * `/api/search` — full-text content search over the indexed markdown bodies.
 *
 * Takes the SAME configured `projectsDir`/`assignmentsDir` the server holds so
 * the index matches exactly what the dashboard displays. Returns NEUTRAL hits
 * (snippet text + `matches` ranges + precomputed `route` + identity fields) —
 * the server emits NO HTML; the client escapes the snippet and wraps the ranges
 * in `<mark>` so highlighting is HTML-safe by construction.
 *
 * Mirrors `createSearchConfigRouter` (Router() factory + try/catch + 500 JSON).
 */
export function createContentSearchRouter(projectsDir: string, assignmentsDir: string): Router {
  const router = Router();

  router.get('/', async (req, res) => {
    try {
      const q = asString(req.query.q)?.trim();
      if (!q) {
        res.status(400).json({ error: 'Query parameter "q" is required' });
        return;
      }

      const project = asString(req.query.project);
      const type = asCsv(req.query.type);
      const status = asCsv(req.query.status);

      let inKinds: FileKind[] | undefined;
      const inRaw = asString(req.query.in);
      if (inRaw !== undefined) {
        try {
          inKinds = parseFileKinds(inRaw);
        } catch (err) {
          res.status(400).json({ error: err instanceof Error ? err.message : 'Invalid "in" filter' });
          return;
        }
      }

      const includeArchived = isTruthy(req.query.all);

      let limit = DEFAULT_LIMIT;
      const limitRaw = asString(req.query.limit);
      if (limitRaw !== undefined) {
        const parsed = Number.parseInt(limitRaw, 10);
        if (Number.isFinite(parsed) && parsed > 0) limit = parsed;
      }
      if (limit > MAX_LIMIT) limit = MAX_LIMIT;

      const docs = await getIndex({ projectsDir, assignmentsDir, includeArchived });
      const provider = resolveProvider();
      await provider.index(docs);

      const searchQuery: SearchQuery = { query: q, project, type, status, in: inKinds };
      const hits = await provider.query(searchQuery, limit);

      res.json({ hits });
    } catch (error) {
      console.error('Error searching content:', error);
      res.status(500).json({ error: 'Failed to search content' });
    }
  });

  return router;
}
