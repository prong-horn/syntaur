import { Router } from 'express';
import {
  readConfig,
  writeWorkspaceVisibilityConfig,
  deleteWorkspaceVisibilityConfig,
} from '../utils/config.js';
import { normalizeHiddenList } from '../utils/workspace-visibility-schema.js';

export function createWorkspaceVisibilityConfigRouter(): Router {
  const router = Router();

  router.get('/', async (_req, res) => {
    try {
      const config = await readConfig();
      const hidden = config.workspaceVisibility.hidden;
      res.json({ hidden, custom: hidden.length > 0 });
    } catch (error) {
      console.error('Error getting workspace-visibility config:', error);
      res.status(500).json({ error: 'Failed to get workspace-visibility config' });
    }
  });

  router.post('/', async (req, res) => {
    try {
      const { hidden } = req.body ?? {};
      if (!Array.isArray(hidden) || hidden.some((h) => typeof h !== 'string')) {
        res.status(400).json({
          error: 'hidden must be an array of strings',
        });
        return;
      }
      const normalized = normalizeHiddenList(hidden);
      await writeWorkspaceVisibilityConfig({ hidden: normalized });
      res.json({ hidden: normalized, custom: normalized.length > 0 });
    } catch (error) {
      console.error('Error saving workspace-visibility config:', error);
      res.status(500).json({ error: 'Failed to save workspace-visibility config' });
    }
  });

  router.delete('/', async (_req, res) => {
    try {
      await deleteWorkspaceVisibilityConfig();
      res.json({ hidden: [], custom: false });
    } catch (error) {
      console.error('Error resetting workspace-visibility config:', error);
      res.status(500).json({ error: 'Failed to reset workspace-visibility config' });
    }
  });

  return router;
}
