/**
 * Dashboard API for scheduled jobs (Task 13). CONTROL-VERB PARITY is the
 * contract: every job-control route calls the SAME schedules lib functions the
 * CLI uses (create/list/show/cancel/hold/release/retry/kill/reschedule) — there
 * is no dashboard-only control path, so a future orchestrator is never locked
 * out. Host/authority ops (`tick`, `install`, `uninstall`) stay CLI/launchd-only
 * by design. The watcher is a pure accelerator wired in server.ts; this router
 * is the human/agent control surface.
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
import { assertUnattendedTerminalSupported } from '../schedules/unattended.js';
import {
  type ScheduledJob,
  type JobTrigger,
  freshAttempt,
  defaultLimits,
  defaultTiming,
} from '../schedules/types.js';
import { getSessionById } from './agent-sessions.js';
import { initSessionDb } from './session-db.js';
import type { TerminalChoice } from '../utils/config.js';
import type { WsMessage } from './types.js';

interface CreateBody {
  assignmentId?: string;
  agentId?: string;
  trigger?: JobTrigger;
  unattended?: boolean;
  terminalPreference?: TerminalChoice | null;
  promptTemplate?: string | null;
  playbook?: string | null;
  note?: string | null;
}

export function createSchedulesRouter(broadcast?: (message: WsMessage) => void): Router {
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
      if (!body.assignmentId || !body.agentId) {
        res.status(400).json({ error: 'assignmentId and agentId are required' });
        return;
      }
      if (!body.trigger || typeof body.trigger.kind !== 'string') {
        res.status(400).json({ error: 'a valid trigger is required' });
        return;
      }
      const unattended = body.unattended !== false;
      const terminal = body.terminalPreference ?? null;
      if (unattended) assertUnattendedTerminalSupported(terminal);

      const now = nowTimestamp();
      const job: ScheduledJob = {
        id: newJobId(),
        assignmentId: body.assignmentId,
        agentId: body.agentId,
        promptTemplate: body.promptTemplate ?? null,
        playbook: body.playbook ?? null,
        terminalPreference: terminal,
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

  // POST /api/schedules/:id/kill — kill the tracked agent session (not the wrapper).
  router.post('/:id/kill', async (req, res) => {
    try {
      const job = await killJob(req.params.id, {
        signalTarget: ({ sessionId, launchPid }) => {
          let pid: number | null = null;
          if (sessionId) {
            try {
              initSessionDb();
              pid = getSessionById(sessionId)?.pid ?? null;
            } catch {
              pid = null;
            }
          }
          pid = pid ?? launchPid;
          if (pid) {
            try {
              process.kill(pid, 'SIGTERM');
            } catch {
              /* already gone */
            }
          }
        },
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
