import { Router } from 'express';
import {
  initLeasesDb,
  listInventories,
  getInventoryDetail,
  forceReleaseLease,
  NotFoundError,
  LeaseContentionError,
} from '../db/leases-db.js';
import type { WsMessage } from './types.js';

export function createLeasesRouter(
  broadcast?: (message: WsMessage) => void,
): Router {
  const router = Router();

  // GET /api/leases — all inventories with members + active leases
  router.get('/', (_req, res) => {
    try {
      initLeasesDb();
      const inventories = listInventories();
      const details = inventories
        .map((inv) => getInventoryDetail(inv.slug))
        .filter((d): d is NonNullable<typeof d> => d !== null);
      res.json({ inventories: details });
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : 'List failed',
      });
    }
  });

  // GET /api/leases/:slug — single inventory detail
  router.get('/:slug', (req, res) => {
    try {
      initLeasesDb();
      const detail = getInventoryDetail(req.params.slug);
      if (!detail) {
        res.status(404).json({ error: 'Inventory not found' });
        return;
      }
      res.json(detail);
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Read failed',
      });
    }
  });

  // POST /api/leases/:slug/force-release/:lease_id — admin force-release
  router.post('/:slug/force-release/:lease_id', (req, res) => {
    try {
      initLeasesDb();
      const result = forceReleaseLease(req.params.lease_id);
      broadcast?.({
        type: 'leases-updated',
        timestamp: new Date().toISOString(),
      });
      res.json({ ...result, lease_id: req.params.lease_id });
    } catch (error) {
      if (error instanceof NotFoundError) {
        res.status(404).json({ error: 'Lease not found' });
        return;
      }
      if (error instanceof LeaseContentionError) {
        res.status(503).json({ error: 'Contention timeout; retry' });
        return;
      }
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Force release failed',
      });
    }
  });

  return router;
}
