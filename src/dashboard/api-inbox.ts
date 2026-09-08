import { Router } from 'express';
import { computeInbox } from '../inbox/index.js';
import { INBOX_CATEGORIES, type InboxCategory, type InboxItem } from '../inbox/types.js';
import { getChatItem } from '../db/chat-db.js';
import type { PermissionRequestItem, QuestionItem } from '../chat/types.js';
import { getStatusConfig } from './api.js';
import { DEFAULT_DERIVE_CONFIG } from '../utils/config.js';

/**
 * Read-only "Needs me" decision inbox API. Localhost-only per the existing
 * dashboard convention (no auth). Mirrors `api-events.ts`'s router shape.
 *
 * Endpoint:
 *   GET /api/inbox
 *     ?project=<slug>        — restrict to one project slug
 *     ?type=<csv>            — restrict to categories (question,review,plan-approval)
 *                              unknown types yield HTTP 400 with a clear message
 *     ?limit=<n>             — truncate returned items (positive int; ignored if invalid)
 *
 * Returns `InboxResult` JSON (items, counts, total).
 *
 * BEST-EFFORT: on ANY error this returns the safe empty shape `{ items: [],
 * counts: { question:0, review:0, 'plan-approval':0 }, total: 0 }`
 * with HTTP 200 so the dashboard never sees a 500 from the inbox endpoint.
 */
function enrichInboxItem(item: InboxItem): InboxItem {
  const kind = item.chat?.kind;
  if (kind !== 'permission' && kind !== 'ask') return item;
  try {
    const chatItem = getChatItem(item.chat!.itemId);
    if (!chatItem) return { ...item, card: null };
    if (chatItem.type === 'permission.request') {
      const perm = chatItem as PermissionRequestItem;
      return {
        ...item,
        card: {
          requestId: perm.requestId,
          kind: 'permission',
          options: perm.options.map((o) => ({
            optionId: o.optionId,
            name: o.name,
            kind: o.kind,
          })),
          settled: Boolean(perm.answer || perm.cancelled || perm.timedOut),
        },
      };
    }
    if (chatItem.type === 'question') {
      const ask = chatItem as QuestionItem;
      return {
        ...item,
        card: {
          requestId: ask.requestId,
          kind: 'ask',
          options: ask.options,
          settled: ask.answer !== null || Boolean(ask.cancelled || ask.timedOut),
        },
      };
    }
    return { ...item, card: null };
  } catch {
    return { ...item, card: null };
  }
}

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

      const resolved = await getStatusConfig();
      // The blocked/parked HEADLINE status ids are NOT valid active "reopen"
      // targets. `derive` is null when the user has no custom derive rules →
      // resolve to DEFAULT_DERIVE_CONFIG.
      const headline = (resolved.derive ?? DEFAULT_DERIVE_CONFIG).headline;
      const blockedParkedStatuses = new Set(
        [headline.blocked, headline.parked].filter(Boolean),
      );
      const statusConfig = { ...resolved, blockedParkedStatuses };
      const result = await computeInbox({
        projectsDir,
        assignmentsDir,
        project,
        types,
        limit,
        statusConfig,
        dashboardUrl: `${req.protocol}://${req.get('host')}`,
      });

      res.json({
        ...result,
        items: result.items.map(enrichInboxItem),
      });
    } catch (error) {
      console.warn('[inbox] failed to compute inbox:', error);
      res.json({
        items: [],
        counts: { question: 0, review: 0, 'plan-approval': 0 },
        total: 0,
      });
    }
  });

  return router;
}
