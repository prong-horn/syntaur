import { Router, type Request, type Response } from 'express';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { ChatBroker } from '../chat/broker.js';
import { resolveTicketById, type ResolvedTicket } from '../utils/ticket-resolver.js';
import { isUuidEntryId } from '../lifecycle/stage-entry.js';
import { StageDispatchError, validateRequestId } from '../chat/stage-dispatch-broker.js';
import { latestStageEntryForTicket } from '../db/events-db.js';
import { parseTicketFrontmatter } from '../lifecycle/frontmatter.js';
import { stageForStatus } from '../ticket-templates/stages.js';
import { verifyHomeOwnerRuntime } from '../chat/broker-owner.js';
import { parseChatRuntimeIdentity } from '../chat/dispatch-client.js';

function getParam(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? '';
  return value ?? '';
}

type StageNotifyBroker = ChatBroker & {
  notifyStageEntry?(ticket: ResolvedTicket): Promise<void>;
};

async function brokerIsLiveOwner(broker: ChatBroker): Promise<boolean> {
  const runtime = broker.runtimeIdentity?.();
  if (!runtime) return false;
  const parsed = parseChatRuntimeIdentity(runtime);
  if (!parsed) return false;
  return verifyHomeOwnerRuntime(parsed);
}

function dispatchStatusCode(state: string): number {
  if (state === 'queued' || state === 'running') return 202;
  return 200;
}

export function createStageDispatchRouter(
  projectsDir: string,
  broker: ChatBroker,
): Router {
  const router = Router();

  router.get('/api/chat/runtime', async (_req: Request, res: Response) => {
    const runtime = broker.runtimeIdentity?.();
    if (!runtime) {
      res.status(503).json({ error: 'broker not ready' });
      return;
    }
    const parsed = parseChatRuntimeIdentity(runtime);
    if (!parsed) {
      res.status(503).json({ error: 'broker runtime identity invalid' });
      return;
    }
    if (!(await verifyHomeOwnerRuntime(parsed))) {
      res.status(503).json({ error: 'broker owner identity mismatch' });
      return;
    }
    res.json(parsed);
  });

  router.post('/api/tickets/:id/stage-entry', async (req: Request, res: Response) => {
    if (!(await brokerIsLiveOwner(broker))) {
      res.status(503).json({ error: 'broker owner unavailable' });
      return;
    }
    try {
      const id = getParam(req.params.id);
      const body = req.body ?? {};
      const entryId = typeof body.entryId === 'string' ? body.entryId.trim() : '';
      if (!entryId || !isUuidEntryId(entryId)) {
        res.status(400).json({ error: 'entryId must be a UUID' });
        return;
      }
      if (Object.keys(body).some((k) => k !== 'entryId')) {
        res.status(400).json({ error: 'unknown fields in body' });
        return;
      }

      const resolved = await resolveTicketById(projectsDir, id);
      if (!resolved) {
        res.status(404).json({ error: `Ticket "${id}" not found` });
        return;
      }

      const ticketMd = await readFile(resolve(resolved.ticketDir, 'ticket.md'), 'utf-8');
      const fm = parseTicketFrontmatter(ticketMd);
      const status = stageForStatus(fm.status);
      const latest = latestStageEntryForTicket(resolved.id);
      if (!latest || latest.eventId !== entryId || latest.stage !== status) {
        res.status(409).json({ error: 'stale or unknown stage entry' });
        return;
      }

      const notifyBroker = broker as StageNotifyBroker;
      if (!notifyBroker.notifyStageEntry) {
        res.status(503).json({ error: 'stage-entry notification unavailable' });
        return;
      }
      await notifyBroker.notifyStageEntry(resolved);
      res.status(204).send();
    } catch (err) {
      console.error('stage-entry notify error:', err);
      res.status(500).json({ error: 'stage-entry notification failed' });
    }
  });

  router.post('/api/tickets/:id/dispatch', async (req: Request, res: Response) => {
    if (!(await brokerIsLiveOwner(broker))) {
      res.status(503).json({ error: 'broker owner unavailable' });
      return;
    }
    try {
      const id = getParam(req.params.id);
      const body = req.body ?? {};
      const entryId = typeof body.entryId === 'string' ? body.entryId.trim() : '';
      const requestId = typeof body.requestId === 'string' ? body.requestId.trim() : '';
      const source = body.source === 'manual' || body.source === 'automatic' ? body.source : null;
      const agentId = typeof body.agentId === 'string' ? body.agentId.trim() : undefined;

      const allowed = new Set(['entryId', 'requestId', 'source', 'agentId']);
      if (Object.keys(body).some((k) => !allowed.has(k))) {
        res.status(400).json({ error: 'unknown fields in body' });
        return;
      }
      if (!entryId || !requestId || !source) {
        res.status(400).json({ error: 'entryId, requestId and source are required' });
        return;
      }
      if (source === 'automatic' && !isUuidEntryId(entryId)) {
        res.status(409).json({ error: 'automatic dispatch requires a UUID entryId' });
        return;
      }
      try {
        validateRequestId(source, requestId, entryId);
      } catch (err) {
        if (err instanceof StageDispatchError) {
          res.status(err.status).json({ error: err.message });
          return;
        }
        throw err;
      }

      const resolved = await resolveTicketById(projectsDir, id);
      if (!resolved) {
        res.status(404).json({ error: `Ticket "${id}" not found` });
        return;
      }

      const result = await broker.dispatchStage({
        ticket: resolved,
        entryId,
        requestId,
        source,
        agentId,
      });
      const receipt = await broker.getStageDispatch(resolved, result.requestId);
      const state = receipt?.state ?? result.state;
      res.status(dispatchStatusCode(state)).json({
        requestId: result.requestId,
        state,
        agentId: receipt?.agentId ?? result.agentId,
        entryId: receipt?.entryId,
        turnId: receipt?.turnId,
        error: receipt?.error,
      });
    } catch (err) {
      if (err instanceof StageDispatchError) {
        res.status(err.status).json({ error: err.message });
        return;
      }
      console.error('dispatch error:', err);
      res.status(500).json({ error: 'dispatch failed' });
    }
  });

  router.get('/api/tickets/:id/dispatch/:requestId', async (req: Request, res: Response) => {
    try {
      const id = getParam(req.params.id);
      const requestId = getParam(req.params.requestId);
      const resolved = await resolveTicketById(projectsDir, id);
      if (!resolved) {
        res.status(404).json({ error: `Ticket "${id}" not found` });
        return;
      }
      const receipt = await broker.getStageDispatch(resolved, requestId);
      if (!receipt) {
        res.status(404).json({ error: 'unknown request' });
        return;
      }
      res.json(receipt);
    } catch (err) {
      console.error('dispatch status error:', err);
      res.status(500).json({ error: 'status read failed' });
    }
  });

  router.post(
    '/api/tickets/:id/dispatch/:requestId/cancel',
    async (req: Request, res: Response) => {
      if (!(await brokerIsLiveOwner(broker))) {
        res.status(503).json({ error: 'broker owner unavailable' });
        return;
      }
      try {
        const id = getParam(req.params.id);
        const requestId = getParam(req.params.requestId);
        const resolved = await resolveTicketById(projectsDir, id);
        if (!resolved) {
          res.status(404).json({ error: `Ticket "${id}" not found` });
          return;
        }
        const cancelled = await broker.cancelStageDispatch(resolved, requestId);
        if (!cancelled) {
          res.status(404).json({ error: 'unknown or terminal request' });
          return;
        }
        res.json({ requestId, state: 'cancelled' });
      } catch (err) {
        console.error('dispatch cancel error:', err);
        res.status(500).json({ error: 'cancel failed' });
      }
    },
  );

  return router;
}
