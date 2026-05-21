import { Router, type Request, type Response, type NextFunction } from 'express';
import { readdir } from 'node:fs/promises';
import { readBundles } from '../todos/bundle-parser.js';
import { readChecklist } from '../todos/parser.js';
import { ensureDir } from '../utils/fs.js';
import type { TodoBundle, TodoItem, BundleStatusSummary } from '../todos/types.js';
import type { WsMessage } from './types.js';

const WORKSPACE_REGEX = /^[a-z0-9_][a-z0-9-]*$/;

function getWorkspaceParam(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? '';
  return value ?? '';
}

function deriveStatus(bundle: TodoBundle, items: TodoItem[]): BundleStatusSummary {
  const members = bundle.todoIds
    .map((id) => items.find((i) => i.id === id))
    .filter((i): i is TodoItem => i !== undefined);
  const counts = { open: 0, in_progress: 0, blocked: 0, completed: 0, total: members.length };
  for (const m of members) counts[m.status]++;
  let status: BundleStatusSummary['status'];
  if (counts.total === 0) status = 'open';
  else if (counts.completed === counts.total) status = 'completed';
  else if (counts.completed > 0 && counts.completed < counts.total) status = 'mixed';
  else if (counts.in_progress > 0) status = 'in_progress';
  else if (counts.blocked > 0) status = 'blocked';
  else status = 'open';
  return { status, counts };
}

interface BundleWithMembers extends TodoBundle {
  members: TodoItem[];
  derivedStatus: BundleStatusSummary;
}

function bundlesInScope(bundles: TodoBundle[], scope: TodoBundle['scope'], scopeId: string): TodoBundle[] {
  return bundles.filter((b) => b.scope === scope && b.scopeId === scopeId);
}

function annotate(bundle: TodoBundle, items: TodoItem[]): BundleWithMembers {
  const memberMap = new Map(items.map((i) => [i.id, i] as const));
  const members = bundle.todoIds.map((id) => memberMap.get(id)).filter((i): i is TodoItem => i !== undefined);
  return { ...bundle, members, derivedStatus: deriveStatus(bundle, items) };
}

export function createBundlesRouter(todosDir: string, broadcast: (msg: WsMessage) => void): Router {
  void broadcast; // v1 is read-only; the broadcast handle is reserved for future mutation routes.
  const router = Router();

  function validateWorkspace(req: Request, res: Response, next: NextFunction): void {
    const workspace = getWorkspaceParam(req.params.workspace);
    if (workspace && !WORKSPACE_REGEX.test(workspace)) {
      res.status(400).json({ error: `Invalid workspace name: "${workspace}"` });
      return;
    }
    next();
  }
  router.param('workspace', validateWorkspace as never);

  // GET / — aggregate across workspace + global scopes
  router.get('/', async (_req, res) => {
    try {
      await ensureDir(todosDir);
      const bundles = await readBundles(todosDir);
      const workspaceFiles = await readdir(todosDir).catch(() => [] as string[]);
      // Map of workspace key → checklist items, plus _global.
      const itemsByKey = new Map<string, TodoItem[]>();
      for (const f of workspaceFiles) {
        if (typeof f !== 'string') continue;
        if (!f.endsWith('.md') || f.endsWith('-log.md')) continue;
        const workspace = f.replace(/\.md$/, '');
        const checklist = await readChecklist(todosDir, workspace);
        itemsByKey.set(workspace, checklist.items);
      }
      if (!itemsByKey.has('_global')) itemsByKey.set('_global', (await readChecklist(todosDir, '_global')).items);

      const scopes: Array<{ scope: TodoBundle['scope']; scopeId: string; bundles: BundleWithMembers[] }> = [];
      // Workspace bundles (non-global).
      const workspaceKeys = [...new Set(bundles.filter((b) => b.scope === 'workspace').map((b) => b.scopeId))];
      for (const key of workspaceKeys) {
        const items = itemsByKey.get(key) ?? (await readChecklist(todosDir, key)).items;
        scopes.push({
          scope: 'workspace',
          scopeId: key,
          bundles: bundlesInScope(bundles, 'workspace', key).map((b) => annotate(b, items)),
        });
      }
      // Global bundles.
      const globalItems = itemsByKey.get('_global') ?? [];
      scopes.push({
        scope: 'global',
        scopeId: '_global',
        bundles: bundlesInScope(bundles, 'global', '_global').map((b) => annotate(b, globalItems)),
      });
      res.json({ scopes });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to list bundles' });
    }
  });

  // GET /:workspace — single workspace (or `_global`)
  router.get('/:workspace', async (req, res) => {
    try {
      const workspace = getWorkspaceParam(req.params.workspace);
      await ensureDir(todosDir);
      const checklist = await readChecklist(todosDir, workspace);
      const bundles = await readBundles(todosDir);
      const scope = workspace === '_global' ? 'global' : 'workspace';
      const scopeId = workspace;
      const filtered = bundlesInScope(bundles, scope, scopeId).map((b) => annotate(b, checklist.items));
      res.json({ scope, scopeId, bundles: filtered });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to list bundles' });
    }
  });

  return router;
}
