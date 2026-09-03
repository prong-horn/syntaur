/**
 * Dashboard API for scheduled jobs (Task 13). CONTROL-VERB PARITY is the
 * contract: every job-control route calls the SAME schedules lib functions the
 * CLI uses (create/list/show/cancel/hold/release/retry/kill/reschedule) — there
 * is no dashboard-only control path, so a future orchestrator is never locked
 * out. Host/authority ops (`tick`, `install`, `uninstall`) stay CLI/launchd-only
 * by design. The watcher is a pure accelerator wired in server.ts; this router
 * is the human/agent control surface.
 *
 * A schedule posts a chat message (Decision 3, phase 4), so `kill` reaches the
 * in-process broker through the `chat` dispatcher this router is handed.
 */

import { Router } from 'express';
import { nowTimestamp } from '../utils/timestamp.js';
import {
  listJobs,
  readJob,
  writeJob,
  newJobId,
} from '../schedules/store.js';
import { appendEvent, readEvents } from '../schedules/event-log.js';
import {
  cancelJob,
  holdJob,
  releaseJob,
  retryJob,
  killJob,
  rescheduleJob,
} from '../schedules/attempt.js';
import {
  type ScheduledJob,
  type JobTrigger,
  freshAttempt,
  defaultLimits,
  defaultTiming,
} from '../schedules/types.js';
import type { ChatDispatcher } from '../schedules/dispatch.js';
import type { WsMessage } from './types.js';

interface CreateBody {
  assignmentId?: string;
  agentId?: string | null;
  message?: string;
  trigger?: JobTrigger;
  unattended?: boolean;
  note?: string | null;
}

export interface SchedulesRouterDeps {
  /** The in-process chat, so `kill` can withdraw or cancel (Decision 3). */
  chat?: ChatDispatcher;
}

export function createSchedulesRouter(
  broadcast?: (message: WsMessage) => void,
  deps: SchedulesRouterDeps = {},
): Router {
  const router = Router();

  const notify = () =>
    broadcast?.({ type: 'schedules-updated', timestamp: new Date().toISOString() });

  // GET /api/schedules — all jobs
  router.get('/', async (_req, res) => {
    try {
      res.json({ schedules: await listJobs() });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'List failed' });
    }
  });

  // GET /api/schedules/:id — one job + its event log
  router.get('/:id', async (req, res) => {
    try {
      const job = await readJob(req.params.id);
      if (!job) {
        res.status(404).json({ error: 'Schedule not found' });
        return;
      }
      res.json({ schedule: job, events: await readEvents(req.params.id) });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Read failed' });
    }
  });

  // POST /api/schedules — create (body carries a pre-built trigger from the UI)
  router.post('/', async (req, res) => {
    try {
      const body = (req.body ?? {}) as CreateBody;
      if (!body.assignmentId) {
        res.status(400).json({ error: 'assignmentId is required' });
        return;
      }
      if (typeof body.message !== 'string' || body.message.trim().length === 0) {
        res.status(400).json({ error: 'message is required' });
        return;
      }
      if (!body.trigger || typeof body.trigger.kind !== 'string') {
        res.status(400).json({ error: 'a valid trigger is required' });
        return;
      }
      const unattended = body.unattended !== false;

      const now = nowTimestamp();
      const job: ScheduledJob = {
        id: newJobId(),
        assignmentId: body.assignmentId,
        agentId: body.agentId ?? null,
        message: body.message,
        unattended,
        limits: defaultLimits(),
        trigger: body.trigger,
        timing: defaultTiming(),
        attempt: freshAttempt(),
        createdAt: now,
        updatedAt: now,
        note: body.note ?? null,
      };
      const written = await writeJob(job);
      await appendEvent(written.id, 'created', { trigger: written.trigger.kind, via: 'dashboard' });
      notify();
      res.status(201).json({ schedule: written });
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : 'Create failed' });
    }
  });

  // Control verbs — each calls the SAME lib function the CLI uses (parity).
  const verb = (name: string, fn: (id: string) => Promise<ScheduledJob>) => {
    router.post(`/:id/${name}`, async (req, res) => {
      try {
        const job = await fn(req.params.id);
        notify();
        res.json({ schedule: job });
      } catch (error) {
        res.status(400).json({ error: error instanceof Error ? error.message : `${name} failed` });
      }
    });
  };
  verb('cancel', cancelJob);
  verb('hold', holdJob);
  verb('release', releaseJob);
  verb('retry', retryJob);

  // POST /api/schedules/:id/kill — withdraw the queued message, or cancel the
  // running turn (Decision 3). There is no pid to signal any more.
  router.post('/:id/kill', async (req, res) => {
    try {
      const chat = deps.chat;
      const job = await killJob(req.params.id, {
        ...(chat
          ? {
              withdrawMessage: (assignmentId: string, messageId: string) =>
                chat.withdraw(assignmentId, messageId),
              cancelTurn: (assignmentId: string, agentId: string | null) =>
                chat.cancel(assignmentId, agentId),
            }
          : {}),
      });
      notify();
      res.json({ schedule: job });
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : 'Kill failed' });
    }
  });

  // POST /api/schedules/:id/reschedule — swap the trigger and re-arm (same lib
  // verb as the CLI; fully resets the attempt + creation baseline).
  router.post('/:id/reschedule', async (req, res) => {
    try {
      const trigger = (req.body ?? {}).trigger as JobTrigger | undefined;
      if (!trigger || typeof trigger.kind !== 'string') {
        res.status(400).json({ error: 'a valid trigger is required' });
        return;
      }
      const job = await rescheduleJob(req.params.id, trigger);
      notify();
      res.json({ schedule: job });
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : 'Reschedule failed' });
    }
  });

  return router;
}
