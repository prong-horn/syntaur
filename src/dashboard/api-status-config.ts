import { Router } from 'express';
import {
  writeStatusConfig,
  deleteStatusConfig,
} from '../utils/config.js';
import { getStatusConfig, clearStatusConfigCache } from './api.js';

/**
 * Express sub-router for `/api/config/statuses`. Mounted on the dashboard
 * server via `app.use('/api/config/statuses', createStatusConfigRouter(...))`.
 *
 * `projectsDir` and `assignmentsDir` are wired through so a future
 * resolution-aware POST handler can scan affected assignments without
 * a second refactor.
 */
export function createStatusConfigRouter(
  _projectsDir: string,
  _assignmentsDir: string | null,
): Router {
  const router = Router();

  router.get('/', async (_req, res) => {
    try {
      const config = await getStatusConfig();
      res.json({
        statuses: config.statuses,
        order: config.order,
        transitions: config.transitions,
        custom: config.custom,
      });
    } catch (error) {
      console.error('Error getting status config:', error);
      res.status(500).json({ error: 'Failed to get status config' });
    }
  });

  router.post('/', async (req, res) => {
    try {
      const { statuses, order, transitions } = req.body;
      if (!Array.isArray(statuses) || !Array.isArray(order) || !Array.isArray(transitions)) {
        res.status(400).json({ error: 'Request body must include statuses, order, and transitions arrays' });
        return;
      }
      await writeStatusConfig({ statuses, order, transitions });
      clearStatusConfigCache();
      const config = await getStatusConfig();
      res.json({
        statuses: config.statuses,
        order: config.order,
        transitions: config.transitions,
        custom: config.custom,
      });
    } catch (error) {
      console.error('Error saving status config:', error);
      res.status(500).json({ error: 'Failed to save status config' });
    }
  });

  router.delete('/', async (_req, res) => {
    try {
      await deleteStatusConfig();
      clearStatusConfigCache();
      const config = await getStatusConfig();
      res.json({
        statuses: config.statuses,
        order: config.order,
        transitions: config.transitions,
        custom: config.custom,
      });
    } catch (error) {
      console.error('Error resetting status config:', error);
      res.status(500).json({ error: 'Failed to reset status config' });
    }
  });

  return router;
}
