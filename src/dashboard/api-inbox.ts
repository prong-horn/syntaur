import { Router } from 'express';
import { computeInbox } from '../inbox/index.js';
import { INBOX_CATEGORIES, type InboxCategory } from '../inbox/types.js';
import { getStatusConfig } from './api.js';

/**
 * Read-only "Needs me" decision inbox API. Localhost-only per the existing
 * dashboard convention (no auth). Mirrors `api-events.ts`'s router shape.
 *
 * Endpoint:
 *   GET /api/inbox
 *     ?project=<slug>        — restrict to one project slug
 *     ?type=<csv>            — restrict to categories (review,blocked,question,plan-approval)
 *                              unknown types yield HTTP 400 with a clear message
 *     ?limit=<n>             — truncate returned items (positive int; ignored if invalid)
 *
 * Returns `InboxResult` JSON (items, counts, total).
 *
 * BEST-EFFORT: on ANY error this returns the safe empty shape `{ items: [],
 * counts: { review:0, blocked:0, question:0, 'plan-approval':0 }, total: 0 }`
 * with HTTP 200 so the dashboard never sees a 500 from the inbox endpoint.
 */
export function createInboxRouter(
  projectsDir: string,
  assignmentsDir: string | null,
): Router {
  const router = Router();

  router.get('/inbox', async (req, res) => {
    try {
      // Parse ?project=<slug>
      const project =
        typeof req.query.project === 'string' && req.query.project.length > 0
          ? req.query.project
          : undefined;

      // Parse ?type=<csv> — unknown types → HTTP 400
      let types: InboxCategory[] | undefined;
      if (typeof req.query.type === 'string' && req.query.type.length > 0) {
        const raw = req.query.type
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean);
        const unknown = raw.filter((t) => !(INBOX_CATEGORIES as readonly string[]).includes(t));
        if (unknown.length > 0) {
          res
            .status(400)
            .json({
              error: `Unknown inbox type(s): ${unknown.map((u) => JSON.stringify(u)).join(', ')}. Valid types: ${INBOX_CATEGORIES.join(', ')}.`,
            });
          return;
        }
        types = raw as InboxCategory[];
      }

      // Parse ?limit=<n> — positive integer; ignore if invalid
      let limit: number | undefined;
      if (typeof req.query.limit === 'string') {
        const n = Number(req.query.limit);
        if (Number.isInteger(n) && n > 0) limit = n;
      }

      const statusConfig = await getStatusConfig();
      const result = await computeInbox({
        projectsDir,
        assignmentsDir,
        project,
        types,
        limit,
        statusConfig,
      });

      res.json(result);
    } catch (error) {
      console.warn('[inbox] failed to compute inbox:', error);
      res.json({
        items: [],
        counts: { review: 0, blocked: 0, question: 0, 'plan-approval': 0 },
        total: 0,
      });
    }
  });

  return router;
}
