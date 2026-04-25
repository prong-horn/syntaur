import { Router, type Request, type Response, type NextFunction } from 'express';
import { mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  readChecklist,
  writeChecklist,
  readLog,
  appendLogEntry,
  archivePath,
  generateUniqueId,
  computeCounts,
} from '../todos/parser.js';
import { fileExists, writeFileForce } from '../utils/fs.js';
import { projectTodosDir } from '../utils/paths.js';
import { isValidSlug } from '../utils/slug.js';
import type { TodoItem, LogEntry } from '../todos/types.js';
import type { WsMessage } from './types.js';

// Per-project write locks, scope-prefixed to avoid collision with the
// workspace router's lock map (keys are `proj:<slug>` here, `ws:<name>` there).
const writeLocks = new Map<string, Promise<void>>();
function projLock<T>(slug: string, fn: () => Promise<T>): Promise<T> {
  const key = `proj:${slug}`;
  const prev = writeLocks.get(key) ?? Promise.resolve();
  const next = prev.then(fn);
  writeLocks.set(key, next.then(() => {}, () => {}));
  return next;
}

function getProjectIdParam(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? '';
  return value ?? '';
}

type ProjectParams = { projectId?: string; id?: string };
function params(req: Request): ProjectParams {
  return req.params as unknown as ProjectParams;
}

async function projectExists(projectsDir: string, slug: string): Promise<boolean> {
  return fileExists(resolve(projectsDir, slug, 'project.md'));
}

async function ensureProjectTodosDir(projectsDir: string, slug: string): Promise<void> {
  const todosDir = projectTodosDir(projectsDir, slug);
  try {
    await mkdir(todosDir, { recursive: false });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') return;
    if (code === 'ENOENT') {
      const e = new Error('PROJECT_GONE');
      (e as NodeJS.ErrnoException).code = 'PROJECT_GONE';
      throw e;
    }
    throw err;
  }
  try {
    await mkdir(resolve(todosDir, 'archive'), { recursive: false });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') return;
    if (code === 'ENOENT') {
      // Project (or its todos/) disappeared between the two mkdirs — map to
      // the same 404 path the caller already handles for PROJECT_GONE.
      const e = new Error('PROJECT_GONE');
      (e as NodeJS.ErrnoException).code = 'PROJECT_GONE';
      throw e;
    }
    throw err;
  }
}

function notFound(res: Response, slug: string): void {
  res.status(404).json({ error: `Project "${slug}" not found` });
}

export function createProjectTodosRouter(
  projectsDir: string,
  broadcast: (msg: WsMessage) => void,
): Router {
  const router = Router({ mergeParams: true });

  function broadcastUpdate(projectSlug: string): void {
    broadcast({ type: 'todos-updated', projectSlug, timestamp: new Date().toISOString() });
  }

  function validateProjectId(req: Request, res: Response, next: NextFunction): void {
    const slug = getProjectIdParam(params(req).projectId);
    if (!slug || !isValidSlug(slug)) {
      res.status(400).json({ error: `Invalid project slug: "${slug}"` });
      return;
    }
    next();
  }

  // router.param only fires for params defined in the subrouter's own route
  // patterns. `:projectId` is on the parent mount path, so run the validator
  // as generic middleware instead.
  router.use(validateProjectId);

  // GET / — list this project's todos
  router.get('/', async (req, res) => {
    try {
      const slug = getProjectIdParam(params(req).projectId);
      if (!(await projectExists(projectsDir, slug))) { notFound(res, slug); return; }
      const todosDir = projectTodosDir(projectsDir, slug);
      const checklist = await readChecklist(todosDir, slug);
      res.json({
        workspace: checklist.workspace,
        archiveInterval: checklist.archiveInterval,
        items: checklist.items,
        counts: computeCounts(checklist.items),
      });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to get todos' });
    }
  });

  // POST / — add item
  router.post('/', async (req, res) => {
    try {
      const slug = getProjectIdParam(params(req).projectId);
      const { description, tags } = req.body;
      if (!description || typeof description !== 'string') {
        res.status(400).json({ error: 'description is required' });
        return;
      }
      if (!(await projectExists(projectsDir, slug))) { notFound(res, slug); return; }

      const item = await projLock(slug, async () => {
        if (!(await projectExists(projectsDir, slug))) return null;
        await ensureProjectTodosDir(projectsDir, slug);
        const todosDir = projectTodosDir(projectsDir, slug);
        const checklist = await readChecklist(todosDir, slug);
        const existingIds = new Set(checklist.items.map((i) => i.id));
        const id = generateUniqueId(existingIds);
        const newItem: TodoItem = {
          id,
          description,
          status: 'open',
          tags: Array.isArray(tags) ? tags : [],
          session: null,
        };
        checklist.workspace = slug;
        checklist.items.push(newItem);
        await writeChecklist(todosDir, checklist);
        return newItem;
      });
      if (!item) { notFound(res, slug); return; }
      broadcastUpdate(slug);
      res.status(201).json(item);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'PROJECT_GONE') {
        notFound(res, getProjectIdParam(params(req).projectId));
        return;
      }
      res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to add todo' });
    }
  });

  // POST /reorder — reorder items (must precede /:id)
  router.post('/reorder', async (req, res) => {
    try {
      const slug = getProjectIdParam(params(req).projectId);
      const { ids } = req.body;
      if (!Array.isArray(ids) || !ids.every((id: unknown) => typeof id === 'string')) {
        res.status(400).json({ error: 'ids must be an array of strings' });
        return;
      }
      if (!(await projectExists(projectsDir, slug))) { notFound(res, slug); return; }

      const items = await projLock(slug, async () => {
        if (!(await projectExists(projectsDir, slug))) return null;
        await ensureProjectTodosDir(projectsDir, slug);
        const todosDir = projectTodosDir(projectsDir, slug);
        const checklist = await readChecklist(todosDir, slug);
        const itemMap = new Map(checklist.items.map((i) => [i.id, i]));
        const reordered: TodoItem[] = [];
        for (const id of ids) {
          const item = itemMap.get(id);
          if (item) { reordered.push(item); itemMap.delete(id); }
        }
        for (const item of itemMap.values()) reordered.push(item);
        checklist.workspace = slug;
        checklist.items = reordered;
        await writeChecklist(todosDir, checklist);
        return reordered;
      });
      if (!items) { notFound(res, slug); return; }
      broadcastUpdate(slug);
      res.json({ items });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'PROJECT_GONE') {
        notFound(res, getProjectIdParam(params(req).projectId));
        return;
      }
      res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to reorder todos' });
    }
  });

  // GET /log — full log (must precede /:id)
  router.get('/log', async (req, res) => {
    try {
      const slug = getProjectIdParam(params(req).projectId);
      if (!(await projectExists(projectsDir, slug))) { notFound(res, slug); return; }
      const todosDir = projectTodosDir(projectsDir, slug);
      const log = await readLog(todosDir, slug);
      res.json(log);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to get log' });
    }
  });

  // POST /archive
  router.post('/archive', async (req, res) => {
    try {
      const slug = getProjectIdParam(params(req).projectId);
      if (!(await projectExists(projectsDir, slug))) { notFound(res, slug); return; }
      const todosDir = projectTodosDir(projectsDir, slug);
      await ensureProjectTodosDir(projectsDir, slug);

      const checklist = await readChecklist(todosDir, slug);
      const log = await readLog(todosDir, slug);
      const completedIds = new Set(
        checklist.items.filter((i) => i.status === 'completed').map((i) => i.id),
      );
      if (completedIds.size === 0) {
        res.json({ archived: 0, message: 'No completed items to archive' });
        return;
      }
      const toArchive = log.entries.filter((e) =>
        e.itemIds.every((id) => completedIds.has(id)),
      );
      const archFile = archivePath(todosDir, slug, checklist.archiveInterval);
      let archContent = '';
      if (await fileExists(archFile)) {
        archContent = await readFile(archFile, 'utf-8');
        archContent = archContent.trimEnd() + '\n\n';
      } else {
        archContent = `---\nworkspace: ${slug}\n---\n\n# Archive\n\n`;
      }
      const completedItems = checklist.items.filter((i) => completedIds.has(i.id));
      for (const item of completedItems) {
        archContent += `- [x] ${item.description} ${item.tags.map((t: string) => `#${t}`).join(' ')} [t:${item.id}]\n`;
      }
      archContent += '\n';
      for (const entry of toArchive) {
        archContent += `### ${entry.timestamp} — ${entry.itemIds.map((i: string) => `t:${i}`).join(', ')}\n`;
        if (entry.items) archContent += `**Items:** ${entry.items}\n`;
        if (entry.session) archContent += `**Session:** ${entry.session}\n`;
        if (entry.branch) archContent += `**Branch:** ${entry.branch}\n`;
        if (entry.summary) archContent += `**Summary:** ${entry.summary}\n`;
        if (entry.blockers) archContent += `**Blockers:** ${entry.blockers}\n`;
        archContent += '\n';
      }
      await writeFileForce(archFile, archContent);

      checklist.workspace = slug;
      checklist.items = checklist.items.filter((i) => !completedIds.has(i.id));
      await writeChecklist(todosDir, checklist);

      broadcastUpdate(slug);
      res.json({ archived: completedIds.size, logEntries: toArchive.length });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'PROJECT_GONE') {
        notFound(res, getProjectIdParam(params(req).projectId));
        return;
      }
      res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to archive' });
    }
  });

  // GET /log/:id — log for a specific item
  router.get('/log/:id', async (req, res) => {
    try {
      const slug = getProjectIdParam(params(req).projectId);
      if (!(await projectExists(projectsDir, slug))) { notFound(res, slug); return; }
      const todosDir = projectTodosDir(projectsDir, slug);
      const log = await readLog(todosDir, slug);
      const entries = log.entries.filter((e) => e.itemIds.includes((params(req).id ?? "")));
      res.json({ workspace: log.workspace, entries });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to get log' });
    }
  });

  // GET /:id — single item with log
  router.get('/:id', async (req, res) => {
    try {
      const slug = getProjectIdParam(params(req).projectId);
      if (!(await projectExists(projectsDir, slug))) { notFound(res, slug); return; }
      const todosDir = projectTodosDir(projectsDir, slug);
      const checklist = await readChecklist(todosDir, slug);
      const item = checklist.items.find((i) => i.id === (params(req).id ?? ""));
      if (!item) { res.status(404).json({ error: `Todo "${(params(req).id ?? "")}" not found` }); return; }
      const log = await readLog(todosDir, slug);
      const logEntries = log.entries.filter((e) => e.itemIds.includes((params(req).id ?? "")));
      res.json({ ...item, log: logEntries });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to get todo' });
    }
  });

  // PATCH /:id
  router.patch('/:id', async (req, res) => {
    try {
      const slug = getProjectIdParam(params(req).projectId);
      if (!(await projectExists(projectsDir, slug))) { notFound(res, slug); return; }
      const result = await projLock(slug, async () => {
        if (!(await projectExists(projectsDir, slug))) return 'gone' as const;
        await ensureProjectTodosDir(projectsDir, slug);
        const todosDir = projectTodosDir(projectsDir, slug);
        const checklist = await readChecklist(todosDir, slug);
        const item = checklist.items.find((i) => i.id === (params(req).id ?? ""));
        if (!item) return null;
        if (req.body.description !== undefined) item.description = req.body.description;
        if (Array.isArray(req.body.tags)) item.tags = req.body.tags;
        checklist.workspace = slug;
        await writeChecklist(todosDir, checklist);
        return { ...item };
      });
      if (result === 'gone') { notFound(res, slug); return; }
      if (!result) { res.status(404).json({ error: `Todo "${(params(req).id ?? "")}" not found` }); return; }
      broadcastUpdate(slug);
      res.json(result);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'PROJECT_GONE') {
        notFound(res, getProjectIdParam(params(req).projectId));
        return;
      }
      res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to update todo' });
    }
  });

  // DELETE /:id
  router.delete('/:id', async (req, res) => {
    try {
      const slug = getProjectIdParam(params(req).projectId);
      if (!(await projectExists(projectsDir, slug))) { notFound(res, slug); return; }
      const deleted = await projLock(slug, async () => {
        if (!(await projectExists(projectsDir, slug))) return 'gone' as const;
        await ensureProjectTodosDir(projectsDir, slug);
        const todosDir = projectTodosDir(projectsDir, slug);
        const checklist = await readChecklist(todosDir, slug);
        const idx = checklist.items.findIndex((i) => i.id === (params(req).id ?? ""));
        if (idx === -1) return false;
        checklist.items.splice(idx, 1);
        checklist.workspace = slug;
        await writeChecklist(todosDir, checklist);
        return true;
      });
      if (deleted === 'gone') { notFound(res, slug); return; }
      if (!deleted) { res.status(404).json({ error: `Todo "${(params(req).id ?? "")}" not found` }); return; }
      broadcastUpdate(slug);
      res.json({ deleted: (params(req).id ?? "") });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'PROJECT_GONE') {
        notFound(res, getProjectIdParam(params(req).projectId));
        return;
      }
      res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to delete todo' });
    }
  });

  // POST /:id/start
  router.post('/:id/start', async (req, res) => {
    try {
      const slug = getProjectIdParam(params(req).projectId);
      if (!(await projectExists(projectsDir, slug))) { notFound(res, slug); return; }
      const result = await projLock(slug, async () => {
        if (!(await projectExists(projectsDir, slug))) return { error: 'gone' as const };
        await ensureProjectTodosDir(projectsDir, slug);
        const todosDir = projectTodosDir(projectsDir, slug);
        const checklist = await readChecklist(todosDir, slug);
        const item = checklist.items.find((i) => i.id === (params(req).id ?? ""));
        if (!item) return { error: 'not_found' as const };
        if (item.status === 'in_progress') return { error: 'conflict' as const, session: item.session };
        item.status = 'in_progress';
        item.session = req.body.session || null;
        checklist.workspace = slug;
        await writeChecklist(todosDir, checklist);
        return { item: { ...item } };
      });
      if ('error' in result) {
        if (result.error === 'gone') { notFound(res, slug); return; }
        if (result.error === 'not_found') { res.status(404).json({ error: `Todo "${(params(req).id ?? "")}" not found` }); return; }
        res.status(409).json({ error: `Todo is already in progress (session: ${result.session})` });
        return;
      }
      broadcastUpdate(slug);
      res.json(result.item);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'PROJECT_GONE') {
        notFound(res, getProjectIdParam(params(req).projectId));
        return;
      }
      res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to start todo' });
    }
  });

  // POST /:id/complete
  router.post('/:id/complete', async (req, res) => {
    try {
      const slug = getProjectIdParam(params(req).projectId);
      if (!(await projectExists(projectsDir, slug))) { notFound(res, slug); return; }
      const result = await projLock(slug, async () => {
        if (!(await projectExists(projectsDir, slug))) return 'gone' as const;
        await ensureProjectTodosDir(projectsDir, slug);
        const todosDir = projectTodosDir(projectsDir, slug);
        const checklist = await readChecklist(todosDir, slug);
        const item = checklist.items.find((i) => i.id === (params(req).id ?? ""));
        if (!item) return null;
        item.status = 'completed';
        item.session = null;
        checklist.workspace = slug;
        await writeChecklist(todosDir, checklist);
        const entry: LogEntry = {
          timestamp: new Date().toISOString(),
          itemIds: [item.id],
          items: item.description,
          session: req.body.session || null,
          branch: req.body.branch || null,
          summary: req.body.summary || 'Completed.',
          blockers: null,
          status: null,
        };
        await appendLogEntry(todosDir, slug, entry);
        return { ...item };
      });
      if (result === 'gone') { notFound(res, slug); return; }
      if (!result) { res.status(404).json({ error: `Todo "${(params(req).id ?? "")}" not found` }); return; }
      broadcastUpdate(slug);
      res.json(result);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'PROJECT_GONE') {
        notFound(res, getProjectIdParam(params(req).projectId));
        return;
      }
      res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to complete todo' });
    }
  });

  // POST /:id/block
  router.post('/:id/block', async (req, res) => {
    try {
      const slug = getProjectIdParam(params(req).projectId);
      const reason = req.body.reason || null;
      if (!(await projectExists(projectsDir, slug))) { notFound(res, slug); return; }
      const result = await projLock(slug, async () => {
        if (!(await projectExists(projectsDir, slug))) return 'gone' as const;
        await ensureProjectTodosDir(projectsDir, slug);
        const todosDir = projectTodosDir(projectsDir, slug);
        const checklist = await readChecklist(todosDir, slug);
        const item = checklist.items.find((i) => i.id === (params(req).id ?? ""));
        if (!item) return null;
        item.status = 'blocked';
        item.session = null;
        checklist.workspace = slug;
        await writeChecklist(todosDir, checklist);
        const entry: LogEntry = {
          timestamp: new Date().toISOString(),
          itemIds: [item.id],
          items: item.description,
          session: req.body.session || null,
          branch: null,
          summary: reason || 'Blocked.',
          blockers: reason,
          status: 'blocked',
        };
        await appendLogEntry(todosDir, slug, entry);
        return { ...item };
      });
      if (result === 'gone') { notFound(res, slug); return; }
      if (!result) { res.status(404).json({ error: `Todo "${(params(req).id ?? "")}" not found` }); return; }
      broadcastUpdate(slug);
      res.json(result);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'PROJECT_GONE') {
        notFound(res, getProjectIdParam(params(req).projectId));
        return;
      }
      res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to block todo' });
    }
  });

  // POST /:id/reopen
  router.post('/:id/reopen', async (req, res) => {
    try {
      const slug = getProjectIdParam(params(req).projectId);
      if (!(await projectExists(projectsDir, slug))) { notFound(res, slug); return; }
      const result = await projLock(slug, async () => {
        if (!(await projectExists(projectsDir, slug))) return 'gone' as const;
        await ensureProjectTodosDir(projectsDir, slug);
        const todosDir = projectTodosDir(projectsDir, slug);
        const checklist = await readChecklist(todosDir, slug);
        const item = checklist.items.find((i) => i.id === (params(req).id ?? ""));
        if (!item) return null;
        item.status = 'open';
        item.session = null;
        checklist.workspace = slug;
        await writeChecklist(todosDir, checklist);
        return { ...item };
      });
      if (result === 'gone') { notFound(res, slug); return; }
      if (!result) { res.status(404).json({ error: `Todo "${(params(req).id ?? "")}" not found` }); return; }
      broadcastUpdate(slug);
      res.json(result);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'PROJECT_GONE') {
        notFound(res, getProjectIdParam(params(req).projectId));
        return;
      }
      res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to reopen todo' });
    }
  });

  // POST /:id/unblock
  router.post('/:id/unblock', async (req, res) => {
    try {
      const slug = getProjectIdParam(params(req).projectId);
      if (!(await projectExists(projectsDir, slug))) { notFound(res, slug); return; }
      const result = await projLock(slug, async () => {
        if (!(await projectExists(projectsDir, slug))) return 'gone' as const;
        await ensureProjectTodosDir(projectsDir, slug);
        const todosDir = projectTodosDir(projectsDir, slug);
        const checklist = await readChecklist(todosDir, slug);
        const item = checklist.items.find((i) => i.id === (params(req).id ?? ""));
        if (!item) return null;
        item.status = 'open';
        item.session = null;
        checklist.workspace = slug;
        await writeChecklist(todosDir, checklist);
        return { ...item };
      });
      if (result === 'gone') { notFound(res, slug); return; }
      if (!result) { res.status(404).json({ error: `Todo "${(params(req).id ?? "")}" not found` }); return; }
      broadcastUpdate(slug);
      res.json(result);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'PROJECT_GONE') {
        notFound(res, getProjectIdParam(params(req).projectId));
        return;
      }
      res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to unblock todo' });
    }
  });

  return router;
}
