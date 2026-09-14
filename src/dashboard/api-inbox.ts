import { Router, type Request } from 'express';
import {
  computeInbox,
  inboxRowKey,
  inboxTier,
  rowFingerprint,
  readSnoozes,
  setSnooze,
  clearSnooze,
  pruneSnoozes,
  snoozeFilePath,
} from '../inbox/index.js';
import { INBOX_CATEGORIES, type InboxCategory } from '../inbox/types.js';
import { getChatItem } from '../db/chat-db.js';

/**
 * Read-only "Needs me" decision inbox API. Localhost-only per the existing
 * dashboard convention (no auth). Mirrors `api-events.ts`'s router shape.
 *
 * Endpoints:
 *   GET /api/inbox
 *     ?project=<slug>        — restrict to one project slug
 *     ?type=<csv>            — restrict to categories (question,review,plan-approval)
 *     ?limit=<n>             — truncate returned items
 *     ?maxAgeDays=<n>        — positive number; tier-0 rows exempt
 *     ?includeSnoozed=1      — include snoozed rows flagged in items
 *
 *   PUT /api/inbox/snoozes/:rowKey   — create/update a snooze
 *   DELETE /api/inbox/snoozes/:rowKey — remove a snooze
 *
 * BEST-EFFORT: on ANY error GET returns the safe empty shape with HTTP 200.
 * Write routes return 4xx/5xx with `{ error }`.
 */

async function baseComputeOptions(req: Request, projectsDir: string) {
  const statusConfig = {
    statuses: [
      { id: 'backlog' },
      { id: 'planning' },
      { id: 'ready' },
      { id: 'in_progress' },
      { id: 'review' },
      { id: 'done', terminal: true },
      { id: 'dropped', terminal: true },
    ],
    transitions: [],
    transitionTable: new Map<string, string>(),
    terminalStatuses: new Set(['done', 'dropped']),
  };
  return {
    projectsDir,
    statusConfig,
    dashboardUrl: `${req.protocol}://${req.get('host')}`,
    lookupChatItem: getChatItem,
  };
}

export function createInboxRouter(projectsDir: string): Router {
  const router = Router();

  router.get('/inbox', async (req, res) => {
    try {
      const project =
        typeof req.query.project === 'string' && req.query.project.length > 0
          ? req.query.project
          : undefined;

      let types: InboxCategory[] | undefined;
      if (typeof req.query.type === 'string' && req.query.type.length > 0) {
        const raw = req.query.type
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean);
        const unknown = raw.filter((t) => !(INBOX_CATEGORIES as readonly string[]).includes(t));
        if (unknown.length > 0) {
          res.status(400).json({
            error: `Unknown inbox type(s): ${unknown.map((u) => JSON.stringify(u)).join(', ')}. Valid types: ${INBOX_CATEGORIES.join(', ')}.`,
          });
          return;
        }
        types = raw as InboxCategory[];
      }

      let limit: number | undefined;
      if (typeof req.query.limit === 'string') {
        const n = Number(req.query.limit);
        if (Number.isInteger(n) && n > 0) limit = n;
      }

      let maxAgeMs: number | undefined;
      if (typeof req.query.maxAgeDays === 'string' && req.query.maxAgeDays.length > 0) {
        const days = Number(req.query.maxAgeDays);
        if (!Number.isFinite(days) || days <= 0) {
          res.status(400).json({ error: 'maxAgeDays must be a positive number' });
          return;
        }
        maxAgeMs = days * 86_400_000;
      }

      const includeSnoozed =
        req.query.includeSnoozed === '1' || req.query.includeSnoozed === 'true';

      const now = Date.now();
      const snoozePath = snoozeFilePath();
      const snoozes = await readSnoozes(snoozePath, now);

      const base = await baseComputeOptions(req, projectsDir);
      const result = await computeInbox({
        ...base,
        project,
        types,
        limit,
        maxAgeMs,
        snoozes,
        includeSnoozed,
        now,
      });

      if (result.liftedSnoozeKeys.length > 0) {
        try {
          await pruneSnoozes(snoozePath, result.liftedSnoozeKeys, now);
        } catch {
          // best effort
        }
      }

      res.json(result);
    } catch (error) {
      console.warn('[inbox] failed to compute inbox:', error);
      res.json({
        items: [],
        counts: { question: 0, review: 0, 'plan-approval': 0 },
        total: 0,
        snoozedCount: 0,
        liftedSnoozeKeys: [],
      });
    }
  });

  router.put('/inbox/snoozes/:rowKey', async (req, res) => {
    try {
      const body = req.body as { untilDays?: unknown; untilChange?: unknown };
      const hasDays = body.untilDays !== undefined;
      const hasChange = body.untilChange === true;
      if (hasDays === hasChange) {
        res.status(400).json({ error: 'Provide exactly one of untilDays or untilChange' });
        return;
      }
      let untilDays: number | undefined;
      if (hasDays) {
        untilDays = body.untilDays as number;
        if (typeof body.untilDays !== 'number' || !Number.isFinite(untilDays) || untilDays <= 0) {
          res.status(400).json({ error: 'untilDays must be a positive number' });
          return;
        }
      }

      const rowKey = req.params.rowKey;
      const now = Date.now();
      const snoozePath = snoozeFilePath();
      const snoozes = await readSnoozes(snoozePath, now);

      const base = await baseComputeOptions(req, projectsDir);
      const result = await computeInbox({
        ...base,
        snoozes,
        includeSnoozed: true,
        now,
      });

      const row = result.items.find((item) => inboxRowKey(item) === rowKey);
      if (!row) {
        res.status(404).json({ error: 'Inbox row not found' });
        return;
      }
      if (inboxTier(row) === 0) {
        res.status(409).json({ error: 'Live cards cannot be snoozed' });
        return;
      }

      const until =
        untilDays !== undefined
          ? new Date(now + untilDays * 86_400_000).toISOString()
          : null;
      await setSnooze(
        snoozePath,
        rowKey,
        {
          until,
          fingerprint: rowFingerprint(row),
          createdAt: new Date(now).toISOString(),
        },
        now,
      );

      res.json({ rowKey, until });
    } catch (error) {
      console.warn('[inbox] failed to set snooze:', error);
      res.status(500).json({ error: 'Failed to set snooze' });
    }
  });

  router.delete('/inbox/snoozes/:rowKey', async (req, res) => {
    try {
      const rowKey = req.params.rowKey;
      const now = Date.now();
      const removed = await clearSnooze(snoozeFilePath(), rowKey, now);
      res.json({ rowKey, removed });
    } catch (error) {
      console.warn('[inbox] failed to clear snooze:', error);
      res.status(500).json({ error: 'Failed to clear snooze' });
    }
  });

  return router;
}
