import { Router } from 'express';
import {
  readConfig,
  getSearchConfig,
  writeSearchConfig,
  deleteSearchConfig,
} from '../utils/config.js';
import {
  ENTITY_KINDS,
  isValidDefaultScope,
  normalizeSearchConfig,
  validateAliases,
} from '../utils/search-schema.js';

/**
 * `/api/config/search` — GET the effective search config (with a `custom` flag),
 * POST to validate + persist, DELETE to reset to defaults. Mirrors
 * `createTerminalConfigRouter`. Aliases validate strictly against
 * `SEARCH_FIELD_NAMES` (shared with the SPA) before persisting.
 */
export function createSearchConfigRouter(): Router {
  const router = Router();

  router.get('/', async (_req, res) => {
    try {
      const config = await readConfig();
      res.json({
        search: getSearchConfig(config),
        custom: config.searchConfig !== null,
      });
    } catch (error) {
      console.error('Error getting search config:', error);
      res.status(500).json({ error: 'Failed to get search config' });
    }
  });

  router.post('/', async (req, res) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;

      if (body['defaultScope'] !== undefined && !isValidDefaultScope(body['defaultScope'])) {
        res.status(400).json({
          error: `defaultScope must be one of: all, ${ENTITY_KINDS.join(', ')}`,
        });
        return;
      }

      const aliasCheck = validateAliases(body['aliases'] ?? {});
      if (!aliasCheck.ok) {
        res.status(400).json({ error: 'Invalid aliases', errors: aliasCheck.errors });
        return;
      }

      const search = normalizeSearchConfig(body);
      await writeSearchConfig(search);
      res.json({ search, custom: true });
    } catch (error) {
      console.error('Error saving search config:', error);
      res.status(500).json({ error: 'Failed to save search config' });
    }
  });

  router.delete('/', async (_req, res) => {
    try {
      await deleteSearchConfig();
      const config = await readConfig();
      res.json({
        search: getSearchConfig(config),
        custom: config.searchConfig !== null,
      });
    } catch (error) {
      console.error('Error resetting search config:', error);
      res.status(500).json({ error: 'Failed to reset search config' });
    }
  });

  return router;
}
