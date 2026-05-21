import { Router, type Request, type Response, type NextFunction } from 'express';
import { resolve } from 'node:path';
import { fileExists } from '../utils/fs.js';
import { projectTodosDir } from '../utils/paths.js';
import { isValidSlug } from '../utils/slug.js';
import { readBundles } from '../todos/bundle-parser.js';
import { readChecklist } from '../todos/parser.js';
import type { TodoBundle, TodoItem, BundleStatusSummary } from '../todos/types.js';
import type { WsMessage } from './types.js';

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

function annotate(bundle: TodoBundle, items: TodoItem[]): BundleWithMembers {
  const memberMap = new Map(items.map((i) => [i.id, i] as const));
  const members = bundle.todoIds.map((id) => memberMap.get(id)).filter((i): i is TodoItem => i !== undefined);
  return { ...bundle, members, derivedStatus: deriveStatus(bundle, items) };
}

function getProjectIdParam(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? '';
  return value ?? '';
}

function notFound(res: Response, slug: string): void {
  res.status(404).json({ error: `Project "${slug}" not found` });
}

export function createProjectBundlesRouter(
  projectsDir: string,
  broadcast: (msg: WsMessage) => void,
): Router {
  void broadcast; // v1 read-only
  const router = Router({ mergeParams: true });

  function validateProjectId(req: Request, res: Response, next: NextFunction): void {
    const slug = getProjectIdParam((req.params as { projectId?: string }).projectId);
    if (!slug || !isValidSlug(slug)) {
      res.status(400).json({ error: `Invalid project slug: "${slug}"` });
      return;
    }
    next();
  }
  router.use(validateProjectId);

  router.get('/', async (req, res) => {
    try {
      const slug = getProjectIdParam((req.params as { projectId?: string }).projectId);
      const projectMd = resolve(projectsDir, slug, 'project.md');
      if (!(await fileExists(projectMd))) {
        notFound(res, slug);
        return;
      }
      const todosDir = projectTodosDir(projectsDir, slug);
      const bundles = await readBundles(todosDir);
      const checklist = await readChecklist(todosDir, slug);
      const filtered = bundles
        .filter((b) => b.scope === 'project' && b.scopeId === slug)
        .map((b) => annotate(b, checklist.items));
      res.json({ scope: 'project', scopeId: slug, bundles: filtered });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to list bundles' });
    }
  });

  return router;
}
