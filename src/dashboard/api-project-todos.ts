import { Router, type Request, type Response, type NextFunction } from 'express';
import { mkdir, readFile, rename } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
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
import { projectTodosDir, todoPlanDir } from '../utils/paths.js';
import { isValidSlug } from '../utils/slug.js';
import { projLock, wsLock, withTwoLocks } from './todos-locks.js';
import type { TodoItem, LogEntry } from '../todos/types.js';
import type { WsMessage } from './types.js';

const WORKSPACE_REGEX = /^[a-z0-9_][a-z0-9-]*$/;

function touchItem(item: TodoItem): void {
  const now = new Date().toISOString();
  if (item.createdAt === null) item.createdAt = now;
  item.updatedAt = now;
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
  workspaceTodosDir?: string,
): Router {
  const router = Router({ mergeParams: true });

  function broadcastUpdate(projectSlug: string): void {
    broadcast({ type: 'todos-updated', projectSlug, timestamp: new Date().toISOString() });
  }
  function broadcastWorkspace(): void {
    broadcast({ type: 'todos-updated', timestamp: new Date().toISOString() });
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
        const now = new Date().toISOString();
        const newItem: TodoItem = {
          id,
          description,
          status: 'open',
          tags: Array.isArray(tags) ? tags : [],
          session: null,
          branch: null,
          worktreePath: null,
          createdAt: now,
          updatedAt: now,
          planDir: null,
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
        touchItem(item);
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
        if (req.body.branch) item.branch = req.body.branch;
        if (req.body.worktreePath) item.worktreePath = req.body.worktreePath;
        touchItem(item);
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
        const branchForLog = req.body.branch || item.branch || null;
        touchItem(item);
        checklist.workspace = slug;
        await writeChecklist(todosDir, checklist);
        const entry: LogEntry = {
          timestamp: new Date().toISOString(),
          itemIds: [item.id],
          items: item.description,
          session: req.body.session || null,
          branch: branchForLog,
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
        touchItem(item);
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
        touchItem(item);
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
        touchItem(item);
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

  // POST /promote — mirror of workspace router; promotes selected project todos
  // to a new or existing assignment.
  router.post('/promote', async (req, res) => {
    try {
      const slug = getProjectIdParam(params(req).projectId);
      if (!(await projectExists(projectsDir, slug))) { notFound(res, slug); return; }

      const { todoIds, mode, target, title, type, priority, keepSource } = req.body ?? {};
      if (!Array.isArray(todoIds) || todoIds.length === 0) {
        res.status(400).json({ error: 'todoIds (non-empty array of strings) is required' });
        return;
      }
      if (mode !== 'new-assignment' && mode !== 'to-assignment') {
        res.status(400).json({ error: 'mode must be "new-assignment" or "to-assignment"' });
        return;
      }

      const result = await projLock(slug, async () => {
        if (!(await projectExists(projectsDir, slug))) return { gone: true } as const;
        await ensureProjectTodosDir(projectsDir, slug);
        const todosDir = projectTodosDir(projectsDir, slug);
        const checklist = await readChecklist(todosDir, slug);

        const items: TodoItem[] = [];
        for (const id of todoIds) {
          const item = checklist.items.find((i) => i.id === id);
          if (!item) return { error: `Todo "${id}" not found` };
          if (item.status === 'completed') return { error: `Todo "${id}" is already completed` };
          items.push(item);
        }

        const scopeLabel = `project:${slug}`;
        const { assignmentsDir: assignmentsDirFn } = await import('../utils/paths.js');
        const { appendTodosToAssignmentBody, touchAssignmentUpdated } = await import(
          '../utils/assignment-todos.js'
        );
        const { nowTimestamp } = await import('../utils/timestamp.js');

        let assignmentRef: string;
        let assignmentDir: string;

        if (mode === 'new-assignment') {
          const targetProject: string | undefined = target?.project ?? slug;
          if (!targetProject) return { error: 'target.project is required for new-assignment mode' };
          if (items.length > 1 && !title) return { error: 'title is required when promoting multiple todos' };
          const { createAssignmentCommand } = await import('../commands/create-assignment.js');
          const created = await createAssignmentCommand(title || items[0].description, {
            project: targetProject,
            type,
            priority,
            withTodos: true,
            silent: true,
          });
          assignmentDir = created.assignmentDir;
          assignmentRef = `${created.projectSlug}/${created.slug}`;
        } else {
          const tg: string = target?.assignment || '';
          if (!tg) return { error: 'target.assignment is required for to-assignment mode' };
          if (tg.includes('/')) {
            const parts = tg.split('/');
            if (parts.length !== 2) return { error: `Invalid target.assignment "${tg}"` };
            assignmentDir = resolve(projectsDir, parts[0], 'assignments', parts[1]);
            assignmentRef = `${parts[0]}/${parts[1]}`;
          } else if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(tg)) {
            assignmentDir = resolve(assignmentsDirFn(), tg);
            assignmentRef = tg;
          } else {
            return { error: `Invalid target.assignment "${tg}"` };
          }
          const assignmentMdPath = resolve(assignmentDir, 'assignment.md');
          if (!(await fileExists(assignmentMdPath))) return { error: `Target assignment not found: ${assignmentMdPath}` };
        }

        const assignmentMdPath = resolve(assignmentDir, 'assignment.md');
        let content = await readFile(assignmentMdPath, 'utf-8');
        content = appendTodosToAssignmentBody(
          content,
          items.map((it) => ({
            description: it.description,
            trace: `promoted from t:${it.id} in ${scopeLabel}`,
          })),
        );
        content = touchAssignmentUpdated(content, nowTimestamp());
        await writeFileForce(assignmentMdPath, content);

        if (!keepSource) {
          for (const item of items) {
            item.status = 'completed';
            item.session = null;
            touchItem(item);
          }
          checklist.workspace = slug;
          await writeChecklist(todosDir, checklist);
          for (const item of items) {
            const entry: LogEntry = {
              timestamp: new Date().toISOString(),
              itemIds: [item.id],
              items: item.description,
              session: null,
              branch: item.branch || null,
              summary: `Promoted to assignment ${assignmentRef}`,
              blockers: null,
              status: null,
            };
            await appendLogEntry(todosDir, slug, entry);
          }
        }

        return { assignmentRef, assignmentDir, promoted: items.map((i) => i.id) };
      });

      if ('gone' in result) { notFound(res, slug); return; }
      if ('error' in result) { res.status(400).json({ error: result.error }); return; }
      broadcastUpdate(slug);
      res.json(result);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'PROJECT_GONE') {
        notFound(res, getProjectIdParam(params(req).projectId));
        return;
      }
      res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to promote todos' });
    }
  });

  // POST /:id/move — cross-scope move from a project to workspace/project/global
  router.post('/:id/move', async (req, res) => {
    try {
      const sourceSlug = getProjectIdParam(params(req).projectId);
      const id = params(req).id ?? '';
      if (!(await projectExists(projectsDir, sourceSlug))) { notFound(res, sourceSlug); return; }

      const to = req.body?.to;
      if (!to || typeof to !== 'object') {
        res.status(400).json({ error: 'body.to is required' });
        return;
      }
      const targetCount = [Boolean(to.workspace), Boolean(to.project), Boolean(to.global)].filter(Boolean).length;
      if (targetCount !== 1) {
        res.status(400).json({ error: 'body.to must specify exactly one of workspace, project, or global' });
        return;
      }
      if (to.project && !isValidSlug(to.project)) {
        res.status(400).json({ error: `Invalid target project slug: "${to.project}"` });
        return;
      }
      if (to.workspace && !WORKSPACE_REGEX.test(to.workspace)) {
        res.status(400).json({ error: `Invalid target workspace name: "${to.workspace}"` });
        return;
      }

      type Target =
        | { kind: 'workspace'; id: string; todosPath: string; lockKey: string }
        | { kind: 'project'; id: string; todosPath: string; lockKey: string };

      let target: Target;
      if (to.global) {
        if (!workspaceTodosDir) {
          res.status(500).json({ error: 'Server not configured with workspaceTodosDir; cannot move to global scope' });
          return;
        }
        target = { kind: 'workspace', id: '_global', todosPath: workspaceTodosDir, lockKey: 'ws:_global' };
      } else if (to.workspace) {
        if (!workspaceTodosDir) {
          res.status(500).json({ error: 'Server not configured with workspaceTodosDir; cannot move to workspace scope' });
          return;
        }
        target = { kind: 'workspace', id: to.workspace, todosPath: workspaceTodosDir, lockKey: `ws:${to.workspace}` };
      } else {
        const tslug = to.project as string;
        if (!(await projectExists(projectsDir, tslug))) {
          res.status(404).json({ error: `Target project "${tslug}" not found` });
          return;
        }
        target = {
          kind: 'project',
          id: tslug,
          todosPath: projectTodosDir(projectsDir, tslug),
          lockKey: `proj:${tslug}`,
        };
      }

      const sourceLockKey = `proj:${sourceSlug}`;
      if (sourceLockKey === target.lockKey) {
        res.status(400).json({ error: 'cannot move to the same scope' });
        return;
      }

      const result = await withTwoLocks(sourceLockKey, target.lockKey, async () => {
        if (!(await projectExists(projectsDir, sourceSlug))) return { status: 'gone' as const };
        if (target.kind === 'project' && !(await projectExists(projectsDir, target.id))) {
          return { status: 'targetGone' as const };
        }
        await ensureProjectTodosDir(projectsDir, sourceSlug);
        const sourceTodosDir = projectTodosDir(projectsDir, sourceSlug);
        const sourceChecklist = await readChecklist(sourceTodosDir, sourceSlug);
        const targetChecklist = await readChecklist(target.todosPath, target.id);

        const idx = sourceChecklist.items.findIndex((i) => i.id === id);
        if (idx === -1) return { status: 404 as const, error: `Todo "${id}" not found` };

        if (targetChecklist.items.some((i) => i.id === id)) {
          return { status: 409 as const, error: 'id already exists in target' };
        }

        const item = sourceChecklist.items[idx];
        if (item.planDir) {
          const newPlanDir = todoPlanDir(target.todosPath, target.id, id);
          if (await fileExists(newPlanDir)) {
            return { status: 409 as const, error: 'plan dir already exists in target' };
          }
          await mkdir(dirname(newPlanDir), { recursive: true });
          await rename(item.planDir, newPlanDir);
          item.planDir = newPlanDir;
        }

        sourceChecklist.items.splice(idx, 1);
        targetChecklist.items.push(item);

        sourceChecklist.workspace = sourceSlug;
        await writeChecklist(sourceTodosDir, sourceChecklist);
        await writeChecklist(target.todosPath, targetChecklist);

        const sourceLabel = `project:${sourceSlug}`;
        const targetLabel =
          target.kind === 'project' ? `project:${target.id}` : target.id === '_global' ? '_global' : `workspace:${target.id}`;
        const ts = new Date().toISOString();
        await appendLogEntry(sourceTodosDir, sourceSlug, {
          timestamp: ts,
          itemIds: [id],
          items: item.description,
          session: null,
          branch: item.branch || null,
          summary: `Moved to ${targetLabel}`,
          blockers: null,
          status: null,
        });
        await appendLogEntry(target.todosPath, target.id, {
          timestamp: ts,
          itemIds: [id],
          items: item.description,
          session: null,
          branch: item.branch || null,
          summary: `Moved from ${sourceLabel}`,
          blockers: null,
          status: null,
        });

        return { status: 200 as const, item };
      });

      if (result.status === 'gone') { notFound(res, sourceSlug); return; }
      if (result.status === 'targetGone') {
        res.status(404).json({ error: `Target project "${(target as { id: string }).id}" not found` });
        return;
      }
      if (result.status !== 200) {
        res.status(result.status).json({ error: result.error });
        return;
      }

      broadcastUpdate(sourceSlug);
      if (target.kind === 'project') broadcastUpdate(target.id);
      else broadcastWorkspace();

      res.json({ moved: id, to: target });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'PROJECT_GONE') {
        notFound(res, getProjectIdParam(params(req).projectId));
        return;
      }
      res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to move todo' });
    }
  });

  return router;
}
