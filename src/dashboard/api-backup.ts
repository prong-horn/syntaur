import { Router } from 'express';
import { updateBackupConfig } from '../utils/config.js';
import {
  backupToGithub,
  restoreFromGithub,
  getBackupStatus,
  parseCategoriesStrict,
  validateRepoUrl,
  VALID_CATEGORIES,
} from '../utils/github-backup.js';

export function createBackupRouter(): Router {
  const router = Router();

  router.get('/', async (_req, res) => {
    try {
      const status = await getBackupStatus();
      res.json(status);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.put('/config', async (req, res) => {
    try {
      const body = req.body ?? {};
      const updates: { repo?: string; categories?: string } = {};

      if (body.repo !== undefined) {
        const trimmed = typeof body.repo === 'string' ? body.repo.trim() : body.repo;
        if (trimmed !== null && trimmed !== '' && !validateRepoUrl(trimmed)) {
          return res.status(400).json({
            error: `Invalid repo URL. Must start with https:// or git@.`,
          });
        }
        updates.repo = trimmed || null as unknown as string;
      }

      if (body.categories !== undefined) {
        let cats: string[];
        if (Array.isArray(body.categories)) {
          cats = body.categories.map((s: unknown) => String(s).trim()).filter(Boolean);
        } else if (typeof body.categories === 'string') {
          cats = body.categories.split(',').map((s: string) => s.trim()).filter(Boolean);
        } else {
          return res.status(400).json({ error: 'categories must be a string or array' });
        }
        if (cats.length === 0) {
          return res.status(400).json({
            error: `No categories provided. Valid: ${VALID_CATEGORIES.join(', ')}`,
          });
        }
        try {
          const valid = parseCategoriesStrict(cats);
          updates.categories = valid.join(', ');
        } catch (err) {
          return res.status(400).json({
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      if (Object.keys(updates).length === 0) {
        return res.status(400).json({ error: 'No fields to update' });
      }

      await updateBackupConfig(updates);
      const status = await getBackupStatus();
      res.json(status);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.post('/push', async (_req, res) => {
    try {
      const result = await backupToGithub();
      res.json(result);
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  router.post('/pull', async (_req, res) => {
    try {
      const result = await restoreFromGithub();
      res.json(result);
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  return router;
}
