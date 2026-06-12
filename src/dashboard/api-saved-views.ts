import { Router, type Request, type Response } from 'express';
import {
  isSavedViewConfig,
  isDashboardSlot,
  type DashboardSlot,
  type SavedViewConfig,
} from '../utils/saved-views-schema.js';
import {
  readSavedViewsFile,
  writeSavedViewsFile,
  createSavedView,
  updateSavedView,
  deleteSavedView,
  setDashboardLayout,
} from '../utils/saved-views.js';
import { withLock } from './todos-locks.js';
import { getStatusConfig } from './api.js';
import { validateQuery } from '../utils/query/index.js';

const SAVED_VIEWS_LOCK = 'sv:global';

function validateCreateBody(
  body: unknown,
): { ok: true; value: { name: string; workspace: string | null; config: SavedViewConfig; entityType?: 'assignment' | 'session' } } | { ok: false; error: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'body must be an object with `name`, `workspace`, and `config`' };
  }
  const obj = body as Record<string, unknown>;
  if (typeof obj.name !== 'string' || obj.name.trim().length === 0 || obj.name.length > 200) {
    return { ok: false, error: 'name must be a non-empty string up to 200 characters' };
  }
  if (obj.workspace !== null && (typeof obj.workspace !== 'string' || obj.workspace.length === 0)) {
    return { ok: false, error: 'workspace must be a non-empty string or null' };
  }
  if (!isSavedViewConfig(obj.config)) {
    return { ok: false, error: 'config must be a valid SavedViewConfig' };
  }
  if (obj.entityType !== undefined && obj.entityType !== 'assignment' && obj.entityType !== 'session') {
    return { ok: false, error: "entityType must be 'assignment' or 'session'" };
  }
  return {
    ok: true,
    value: {
      name: obj.name.trim(),
      workspace: obj.workspace as string | null,
      config: obj.config,
      ...(obj.entityType !== undefined ? { entityType: obj.entityType as 'assignment' | 'session' } : {}),
    },
  };
}

function validateUpdateBody(
  body: unknown,
): { ok: true; value: { name?: string; workspace?: string | null; config?: SavedViewConfig } } | { ok: false; error: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'body must be an object' };
  }
  const obj = body as Record<string, unknown>;
  const patch: { name?: string; workspace?: string | null; config?: SavedViewConfig } = {};
  if (obj.name !== undefined) {
    if (typeof obj.name !== 'string' || obj.name.trim().length === 0 || obj.name.length > 200) {
      return { ok: false, error: 'name must be a non-empty string up to 200 characters' };
    }
    patch.name = obj.name.trim();
  }
  if (obj.workspace !== undefined) {
    if (obj.workspace !== null && (typeof obj.workspace !== 'string' || obj.workspace.length === 0)) {
      return { ok: false, error: 'workspace must be a non-empty string or null' };
    }
    patch.workspace = obj.workspace as string | null;
  }
  if (obj.config !== undefined) {
    if (!isSavedViewConfig(obj.config)) {
      return { ok: false, error: 'config must be a valid SavedViewConfig' };
    }
    patch.config = obj.config;
  }
  if (Object.keys(patch).length === 0) {
    return { ok: false, error: 'patch must include at least one of name, workspace, or config' };
  }
  return { ok: true, value: patch };
}

function validateDashboardBody(
  body: unknown,
): { ok: true; value: DashboardSlot[] } | { ok: false; error: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'body must be an object with a `slots` array' };
  }
  const obj = body as Record<string, unknown>;
  if (!Array.isArray(obj.slots)) {
    return { ok: false, error: 'slots must be an array' };
  }
  if (!obj.slots.every(isDashboardSlot)) {
    return {
      ok: false,
      error: 'every slot must be { id: string, widget: WidgetConfig | null, size?: WidgetSize }',
    };
  }
  return { ok: true, value: obj.slots };
}

export function createSavedViewsRouter(): Router {
  const router = Router();

  router.get('/', async (_req: Request, res: Response) => {
    try {
      const file = await readSavedViewsFile();
      res.json(file);
    } catch (error) {
      console.error('Error reading saved-views:', error);
      res.status(500).json({ error: 'Failed to read saved-views' });
    }
  });

  router.post('/', async (req: Request, res: Response) => {
    const result = validateCreateBody(req.body);
    if (!result.ok) {
      res.status(400).json({ error: result.error });
      return;
    }
    const queryStr = result.value.config.filters.query;
    if (typeof queryStr === 'string' && queryStr.length > 0) {
      const statusConfig = await getStatusConfig();
      const queryErrors = validateQuery(queryStr, statusConfig.queryRegistry);
      if (queryErrors.length > 0) {
        res.status(400).json({ errors: queryErrors });
        return;
      }
    }
    try {
      const file = await withLock(SAVED_VIEWS_LOCK, async () => {
        const current = await readSavedViewsFile();
        const next = createSavedView(current, result.value);
        await writeSavedViewsFile(next.file);
        return next.file;
      });
      res.status(201).json(file);
    } catch (error) {
      console.error('Error creating saved-view:', error);
      res.status(500).json({ error: 'Failed to create saved-view' });
    }
  });

  router.patch('/:id', async (req: Request, res: Response) => {
    const idParam = req.params.id;
    if (typeof idParam !== 'string' || idParam.length === 0) {
      res.status(400).json({ error: 'id required' });
      return;
    }
    const result = validateUpdateBody(req.body);
    if (!result.ok) {
      res.status(400).json({ error: result.error });
      return;
    }
    const patchQueryStr = result.value.config?.filters.query;
    if (typeof patchQueryStr === 'string' && patchQueryStr.length > 0) {
      const statusConfig = await getStatusConfig();
      const queryErrors = validateQuery(patchQueryStr, statusConfig.queryRegistry);
      if (queryErrors.length > 0) {
        res.status(400).json({ errors: queryErrors });
        return;
      }
    }
    try {
      const outcome = await withLock(SAVED_VIEWS_LOCK, async () => {
        const current = await readSavedViewsFile();
        const next = updateSavedView(current, idParam, result.value);
        if ('error' in next) return { kind: 'not-found' as const };
        await writeSavedViewsFile(next.file);
        return { kind: 'ok' as const, file: next.file };
      });
      if (outcome.kind === 'not-found') {
        res.status(404).json({ error: 'view-not-found' });
        return;
      }
      res.json(outcome.file);
    } catch (error) {
      console.error('Error updating saved-view:', error);
      res.status(500).json({ error: 'Failed to update saved-view' });
    }
  });

  router.delete('/:id', async (req: Request, res: Response) => {
    const idParam = req.params.id;
    if (typeof idParam !== 'string' || idParam.length === 0) {
      res.status(400).json({ error: 'id required' });
      return;
    }
    try {
      const outcome = await withLock(SAVED_VIEWS_LOCK, async () => {
        const current = await readSavedViewsFile();
        const next = deleteSavedView(current, idParam);
        if (!next.deleted) return { kind: 'not-found' as const };
        await writeSavedViewsFile(next.file);
        return { kind: 'ok' as const, file: next.file };
      });
      if (outcome.kind === 'not-found') {
        res.status(404).json({ error: 'view-not-found' });
        return;
      }
      res.json(outcome.file);
    } catch (error) {
      console.error('Error deleting saved-view:', error);
      res.status(500).json({ error: 'Failed to delete saved-view' });
    }
  });

  return router;
}

export function createDashboardLayoutRouter(): Router {
  const router = Router();

  router.put('/', async (req: Request, res: Response) => {
    const result = validateDashboardBody(req.body);
    if (!result.ok) {
      res.status(400).json({ error: result.error });
      return;
    }
    try {
      const outcome = await withLock(SAVED_VIEWS_LOCK, async () => {
        const current = await readSavedViewsFile();
        const next = setDashboardLayout(current, result.value);
        if ('error' in next) return { kind: 'bad-ref' as const, viewId: next.viewId };
        await writeSavedViewsFile(next.file);
        return { kind: 'ok' as const, file: next.file };
      });
      if (outcome.kind === 'bad-ref') {
        res.status(400).json({ error: 'unknown-view-id', viewId: outcome.viewId });
        return;
      }
      res.json(outcome.file);
    } catch (error) {
      console.error('Error updating dashboard:', error);
      res.status(500).json({ error: 'Failed to update dashboard' });
    }
  });

  return router;
}
