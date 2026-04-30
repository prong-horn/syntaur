import { Router, type Request, type Response, type NextFunction } from 'express';
import { readdir } from 'node:fs/promises';
import {
  readChecklist,
  writeChecklist,
  readLog,
  appendLogEntry,
  generateUniqueId,
  computeCounts,
} from '../todos/parser.js';
import { resolve as resolvePath, dirname } from 'node:path';
import { rename, mkdir } from 'node:fs/promises';
import { ensureDir, fileExists } from '../utils/fs.js';
import { projectTodosDir, todoPlanDir } from '../utils/paths.js';
import { wsLock, projLock, withTwoLocks, globalLockKey } from './todos-locks.js';
import { isValidSlug } from '../utils/slug.js';
import type { TodoItem, LogEntry } from '../todos/types.js';
import type { WsMessage } from './types.js';

const WORKSPACE_REGEX = /^[a-z0-9_][a-z0-9-]*$/;

function getWorkspaceParam(value: string | string[] | undefined): string {
  if (Array.isArray(value)) {
    return value[0] ?? '';
  }
  return value ?? '';
}

function touchItem(item: TodoItem): void {
  const now = new Date().toISOString();
  if (item.createdAt === null) item.createdAt = now;
  item.updatedAt = now;
}

export function createTodosRouter(
  todosDir: string,
  broadcast: (msg: WsMessage) => void,
  projectsDir?: string,
): Router {
  const router = Router();

  function broadcastUpdate(): void {
    broadcast({ type: 'todos-updated', timestamp: new Date().toISOString() });
  }
  function broadcastProject(slug: string): void {
    broadcast({ type: 'todos-updated', projectSlug: slug, timestamp: new Date().toISOString() });
  }

  // Validate workspace name on all routes that use :workspace
  function validateWorkspace(req: Request, res: Response, next: NextFunction): void {
    const workspace = getWorkspaceParam(req.params.workspace);
    if (workspace && !WORKSPACE_REGEX.test(workspace)) {
      res.status(400).json({ error: `Invalid workspace name: "${workspace}". Use lowercase letters, numbers, hyphens, and underscores.` });
      return;
    }
    next();
  }

  // Apply workspace validation to all parameterized routes
  router.param('workspace', validateWorkspace as any);

  // GET / — aggregate all workspace checklists
  router.get('/', async (_req, res) => {
    try {
      await ensureDir(todosDir);
      const files = await readdir(todosDir).catch(() => []);
      const workspaces: Array<{
        workspace: string;
        archiveInterval: string;
        items: TodoItem[];
        counts: ReturnType<typeof computeCounts>;
      }> = [];

      for (const file of files) {
        if (typeof file !== 'string') continue;
        if (!file.endsWith('.md') || file.endsWith('-log.md')) continue;
        const workspace = file.replace('.md', '');
        const checklist = await readChecklist(todosDir, workspace);
        workspaces.push({
          workspace: checklist.workspace,
          archiveInterval: checklist.archiveInterval,
          items: checklist.items,
          counts: computeCounts(checklist.items),
        });
      }

      res.json({ workspaces });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to list todos' });
    }
  });

  // GET /:workspace — list items for one workspace
  router.get('/:workspace', async (req, res) => {
    try {
      const workspace = getWorkspaceParam(req.params.workspace);
      const checklist = await readChecklist(todosDir, workspace);
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

  // POST /:workspace — add item
  router.post('/:workspace', async (req, res) => {
    try {
      const workspace = getWorkspaceParam(req.params.workspace);
      const { description, tags } = req.body;
      if (!description || typeof description !== 'string') {
        res.status(400).json({ error: 'description is required' });
        return;
      }

      const item = await wsLock(workspace, async () => {
        const checklist = await readChecklist(todosDir, workspace);
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
        checklist.items.push(newItem);
        await writeChecklist(todosDir, checklist);
        return newItem;
      });
      broadcastUpdate();
      res.status(201).json(item);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to add todo' });
    }
  });

  // POST /:workspace/reorder — reorder items
  // Must be before /:workspace/:id to avoid param capture
  router.post('/:workspace/reorder', async (req, res) => {
    try {
      const workspace = getWorkspaceParam(req.params.workspace);
      const { ids } = req.body;
      if (!Array.isArray(ids) || !ids.every((id: unknown) => typeof id === 'string')) {
        res.status(400).json({ error: 'ids must be an array of strings' });
        return;
      }

      const items = await wsLock(workspace, async () => {
        const checklist = await readChecklist(todosDir, workspace);
        const itemMap = new Map(checklist.items.map((i) => [i.id, i]));

        // Build reordered list: requested order first, then any items not in the ids array
        const reordered: TodoItem[] = [];
        for (const id of ids) {
          const item = itemMap.get(id);
          if (item) {
            reordered.push(item);
            itemMap.delete(id);
          }
        }
        // Append any remaining items not mentioned in ids
        for (const item of itemMap.values()) {
          reordered.push(item);
        }

        checklist.items = reordered;
        await writeChecklist(todosDir, checklist);
        return reordered;
      });
      broadcastUpdate();
      res.json({ items });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to reorder todos' });
    }
  });

  // GET /:workspace/log — full log
  // Must be before /:workspace/:id to avoid param capture
  router.get('/:workspace/log', async (req, res) => {
    try {
      const log = await readLog(todosDir, getWorkspaceParam(req.params.workspace));
      res.json(log);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to get log' });
    }
  });

  // POST /:workspace/archive — trigger archive
  router.post('/:workspace/archive', async (req, res) => {
    try {
      // Import archive logic inline to avoid circular deps
      const { archivePath } = await import('../todos/parser.js');
      const { resolve } = await import('node:path');
      const { readFile } = await import('node:fs/promises');
      const { writeFileForce } = await import('../utils/fs.js');

      const workspace = getWorkspaceParam(req.params.workspace);
      const checklist = await readChecklist(todosDir, workspace);
      const log = await readLog(todosDir, workspace);

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

      const archFile = archivePath(todosDir, workspace, checklist.archiveInterval);
      await ensureDir(resolve(todosDir, 'archive'));
      let archContent = '';
      if (await fileExists(archFile)) {
        archContent = await readFile(archFile, 'utf-8');
        archContent = archContent.trimEnd() + '\n\n';
      } else {
        archContent = `---\nworkspace: ${workspace}\n---\n\n# Archive\n\n`;
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

      checklist.items = checklist.items.filter((i) => !completedIds.has(i.id));
      await writeChecklist(todosDir, checklist);

      broadcastUpdate();
      res.json({ archived: completedIds.size, logEntries: toArchive.length });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to archive' });
    }
  });

  // GET /:workspace/log/:id — log for specific item
  router.get('/:workspace/log/:id', async (req, res) => {
    try {
      const log = await readLog(todosDir, getWorkspaceParam(req.params.workspace));
      const entries = log.entries.filter((e) => e.itemIds.includes(req.params.id));
      res.json({ workspace: log.workspace, entries });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to get log' });
    }
  });

  // GET /:workspace/:id — single item with log
  router.get('/:workspace/:id', async (req, res) => {
    try {
      const workspace = getWorkspaceParam(req.params.workspace);
      const checklist = await readChecklist(todosDir, workspace);
      const item = checklist.items.find((i) => i.id === req.params.id);
      if (!item) {
        res.status(404).json({ error: `Todo "${req.params.id}" not found` });
        return;
      }
      const log = await readLog(todosDir, workspace);
      const logEntries = log.entries.filter((e) => e.itemIds.includes(req.params.id));
      res.json({ ...item, log: logEntries });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to get todo' });
    }
  });

  // PATCH /:workspace/:id — update description or tags
  router.patch('/:workspace/:id', async (req, res) => {
    try {
      const workspace = getWorkspaceParam(req.params.workspace);
      const result = await wsLock(workspace, async () => {
        const checklist = await readChecklist(todosDir, workspace);
        const item = checklist.items.find((i) => i.id === req.params.id);
        if (!item) return null;
        if (req.body.description !== undefined) item.description = req.body.description;
        if (Array.isArray(req.body.tags)) item.tags = req.body.tags;
        touchItem(item);
        await writeChecklist(todosDir, checklist);
        return { ...item };
      });
      if (!result) { res.status(404).json({ error: `Todo "${req.params.id}" not found` }); return; }
      broadcastUpdate();
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to update todo' });
    }
  });

  // DELETE /:workspace/:id
  router.delete('/:workspace/:id', async (req, res) => {
    try {
      const workspace = getWorkspaceParam(req.params.workspace);
      const deleted = await wsLock(workspace, async () => {
        const checklist = await readChecklist(todosDir, workspace);
        const idx = checklist.items.findIndex((i) => i.id === req.params.id);
        if (idx === -1) return false;
        checklist.items.splice(idx, 1);
        await writeChecklist(todosDir, checklist);
        return true;
      });
      if (!deleted) { res.status(404).json({ error: `Todo "${req.params.id}" not found` }); return; }
      broadcastUpdate();
      res.json({ deleted: req.params.id });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to delete todo' });
    }
  });

  // POST /:workspace/:id/start
  router.post('/:workspace/:id/start', async (req, res) => {
    try {
      const workspace = getWorkspaceParam(req.params.workspace);
      const result = await wsLock(workspace, async () => {
        const checklist = await readChecklist(todosDir, workspace);
        const item = checklist.items.find((i) => i.id === req.params.id);
        if (!item) return { error: 'not_found' as const };
        if (item.status === 'in_progress') return { error: 'conflict' as const, session: item.session };
        item.status = 'in_progress';
        item.session = req.body.session || null;
        if (req.body.branch) item.branch = req.body.branch;
        if (req.body.worktreePath) item.worktreePath = req.body.worktreePath;
        touchItem(item);
        await writeChecklist(todosDir, checklist);
        return { item: { ...item } };
      });
      if ('error' in result) {
        if (result.error === 'not_found') { res.status(404).json({ error: `Todo "${req.params.id}" not found` }); return; }
        res.status(409).json({ error: `Todo is already in progress (session: ${result.session})` }); return;
      }
      broadcastUpdate();
      res.json(result.item);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to start todo' });
    }
  });

  // POST /:workspace/:id/complete
  router.post('/:workspace/:id/complete', async (req, res) => {
    try {
      const workspace = getWorkspaceParam(req.params.workspace);
      const result = await wsLock(workspace, async () => {
        const checklist = await readChecklist(todosDir, workspace);
        const item = checklist.items.find((i) => i.id === req.params.id);
        if (!item) return null;
        item.status = 'completed';
        item.session = null;
        const branchForLog = req.body.branch || item.branch || null;
        touchItem(item);
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
        await appendLogEntry(todosDir, workspace, entry);
        return { ...item };
      });
      if (!result) { res.status(404).json({ error: `Todo "${req.params.id}" not found` }); return; }
      broadcastUpdate();
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to complete todo' });
    }
  });

  // POST /:workspace/:id/block
  router.post('/:workspace/:id/block', async (req, res) => {
    try {
      const reason = req.body.reason || null;
      const workspace = getWorkspaceParam(req.params.workspace);
      const result = await wsLock(workspace, async () => {
        const checklist = await readChecklist(todosDir, workspace);
        const item = checklist.items.find((i) => i.id === req.params.id);
        if (!item) return null;
        item.status = 'blocked';
        item.session = null;
        touchItem(item);
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
        await appendLogEntry(todosDir, workspace, entry);
        return { ...item };
      });
      if (!result) { res.status(404).json({ error: `Todo "${req.params.id}" not found` }); return; }
      broadcastUpdate();
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to block todo' });
    }
  });

  // POST /:workspace/:id/reopen — move completed back to open
  router.post('/:workspace/:id/reopen', async (req, res) => {
    try {
      const workspace = getWorkspaceParam(req.params.workspace);
      const result = await wsLock(workspace, async () => {
        const checklist = await readChecklist(todosDir, workspace);
        const item = checklist.items.find((i) => i.id === req.params.id);
        if (!item) return null;
        item.status = 'open';
        item.session = null;
        touchItem(item);
        await writeChecklist(todosDir, checklist);
        return { ...item };
      });
      if (!result) { res.status(404).json({ error: `Todo "${req.params.id}" not found` }); return; }
      broadcastUpdate();
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to reopen todo' });
    }
  });

  // POST /:workspace/promote
  router.post('/:workspace/promote', async (req, res) => {
    try {
      const workspace = getWorkspaceParam(req.params.workspace);
      const { todoIds, mode, target, title, type, priority, keepSource } = req.body ?? {};
      if (!Array.isArray(todoIds) || todoIds.length === 0) {
        res.status(400).json({ error: 'todoIds (non-empty array of strings) is required' });
        return;
      }
      if (mode !== 'new-assignment' && mode !== 'to-assignment') {
        res.status(400).json({ error: 'mode must be "new-assignment" or "to-assignment"' });
        return;
      }

      const result = await wsLock(workspace, async () => {
        const checklist = await readChecklist(todosDir, workspace);
        const items: TodoItem[] = [];
        for (const id of todoIds) {
          const item = checklist.items.find((i) => i.id === id);
          if (!item) return { error: `Todo "${id}" not found` };
          if (item.status === 'completed') return { error: `Todo "${id}" is already completed` };
          items.push(item);
        }

        const scopeLabel = workspace === '_global' ? '_global' : `workspace:${workspace}`;
        const { resolve: resolvePath } = await import('node:path');
        const { readConfig } = await import('../utils/config.js');
        const { assignmentsDir: assignmentsDirFn } = await import('../utils/paths.js');
        const { fileExists, writeFileForce } = await import('../utils/fs.js');
        const { readFile } = await import('node:fs/promises');
        const { appendTodosToAssignmentBody, touchAssignmentUpdated } = await import('../utils/assignment-todos.js');
        const { nowTimestamp } = await import('../utils/timestamp.js');

        let assignmentRef: string;
        let assignmentDir: string;

        if (mode === 'new-assignment') {
          const targetProject: string | undefined = target?.project;
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
            const config = await readConfig();
            assignmentDir = resolvePath(config.defaultProjectDir, parts[0], 'assignments', parts[1]);
            assignmentRef = `${parts[0]}/${parts[1]}`;
          } else if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(tg)) {
            assignmentDir = resolvePath(assignmentsDirFn(), tg);
            assignmentRef = tg;
          } else {
            return { error: `Invalid target.assignment "${tg}"` };
          }
          const assignmentMdPath = resolvePath(assignmentDir, 'assignment.md');
          if (!(await fileExists(assignmentMdPath))) return { error: `Target assignment not found: ${assignmentMdPath}` };
        }

        const assignmentMdPath = resolvePath(assignmentDir, 'assignment.md');
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
            await appendLogEntry(todosDir, workspace, entry);
          }
        }

        return { assignmentRef, assignmentDir, promoted: items.map((i) => i.id) };
      });

      if ('error' in result) { res.status(400).json({ error: result.error }); return; }
      broadcastUpdate();
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to promote todos' });
    }
  });

  // POST /:workspace/:id/move — cross-scope move (workspace/global ↔ project/global)
  router.post('/:workspace/:id/move', async (req, res) => {
    try {
      const sourceWs = getWorkspaceParam(req.params.workspace);
      const id = req.params.id;
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

      // Resolve target scope details (todosPath, scope id, lock key, broadcast).
      type Target =
        | { kind: 'workspace'; id: string; todosPath: string; lockKey: string }
        | { kind: 'project'; id: string; todosPath: string; lockKey: string };

      let target: Target;
      if (to.global) {
        target = { kind: 'workspace', id: '_global', todosPath: todosDir, lockKey: 'ws:_global' };
      } else if (to.workspace) {
        target = { kind: 'workspace', id: to.workspace, todosPath: todosDir, lockKey: `ws:${to.workspace}` };
      } else {
        if (!projectsDir) {
          res.status(500).json({ error: 'Server not configured with projectsDir; cannot move to project scope' });
          return;
        }
        const slug = to.project as string;
        const projectMd = resolvePath(projectsDir, slug, 'project.md');
        if (!(await fileExists(projectMd))) {
          res.status(404).json({ error: `Target project "${slug}" not found` });
          return;
        }
        target = {
          kind: 'project',
          id: slug,
          todosPath: projectTodosDir(projectsDir, slug),
          lockKey: `proj:${slug}`,
        };
      }

      const sourceLockKey = `ws:${sourceWs}`;
      if (sourceLockKey === target.lockKey) {
        res.status(400).json({ error: 'cannot move to the same scope' });
        return;
      }

      const result = await withTwoLocks(sourceLockKey, target.lockKey, async () => {
        const sourceChecklist = await readChecklist(todosDir, sourceWs);
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

        await writeChecklist(todosDir, sourceChecklist);
        await writeChecklist(target.todosPath, targetChecklist);

        const sourceLabel = sourceWs === '_global' ? '_global' : `workspace:${sourceWs}`;
        const targetLabel =
          target.kind === 'project' ? `project:${target.id}` : target.id === '_global' ? '_global' : `workspace:${target.id}`;
        const ts = new Date().toISOString();
        await appendLogEntry(todosDir, sourceWs, {
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

      if (result.status !== 200) {
        res.status(result.status).json({ error: result.error });
        return;
      }

      // Dual broadcast: source scope, then target scope.
      broadcastUpdate(); // source is workspace
      if (target.kind === 'project') broadcastProject(target.id);
      else broadcastUpdate();

      res.json({ moved: id, to: target });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to move todo' });
    }
  });

  // POST /:workspace/:id/unblock
  router.post('/:workspace/:id/unblock', async (req, res) => {
    try {
      const workspace = getWorkspaceParam(req.params.workspace);
      const result = await wsLock(workspace, async () => {
        const checklist = await readChecklist(todosDir, workspace);
        const item = checklist.items.find((i) => i.id === req.params.id);
        if (!item) return null;
        item.status = 'open';
        item.session = null;
        touchItem(item);
        await writeChecklist(todosDir, checklist);
        return { ...item };
      });
      if (!result) { res.status(404).json({ error: `Todo "${req.params.id}" not found` }); return; }
      broadcastUpdate();
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to unblock todo' });
    }
  });

  return router;
}
