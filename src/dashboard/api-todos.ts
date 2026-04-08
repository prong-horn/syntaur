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
import { ensureDir, fileExists } from '../utils/fs.js';
import type { TodoItem, LogEntry } from '../todos/types.js';
import type { WsMessage } from './types.js';

const WORKSPACE_REGEX = /^[a-z0-9_][a-z0-9-]*$/;

// Per-workspace write lock to prevent concurrent read-modify-write races
const writeLocks = new Map<string, Promise<void>>();
function withLock<T>(workspace: string, fn: () => Promise<T>): Promise<T> {
  const prev = writeLocks.get(workspace) ?? Promise.resolve();
  const next = prev.then(fn);
  writeLocks.set(workspace, next.then(() => {}, () => {}));
  return next;
}

export function createTodosRouter(
  todosDir: string,
  broadcast: (msg: WsMessage) => void,
): Router {
  const router = Router();

  function broadcastUpdate(): void {
    broadcast({ type: 'todos-updated', timestamp: new Date().toISOString() });
  }

  // Validate workspace name on all routes that use :workspace
  function validateWorkspace(req: Request, res: Response, next: NextFunction): void {
    if (req.params.workspace && !WORKSPACE_REGEX.test(req.params.workspace)) {
      res.status(400).json({ error: `Invalid workspace name: "${req.params.workspace}". Use lowercase letters, numbers, hyphens, and underscores.` });
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
      const { workspace } = req.params;
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
      const { workspace } = req.params;
      const { description, tags } = req.body;
      if (!description || typeof description !== 'string') {
        res.status(400).json({ error: 'description is required' });
        return;
      }

      const item = await withLock(workspace, async () => {
        const checklist = await readChecklist(todosDir, workspace);
        const existingIds = new Set(checklist.items.map((i) => i.id));
        const id = generateUniqueId(existingIds);

        const newItem: TodoItem = {
          id,
          description,
          status: 'open',
          tags: Array.isArray(tags) ? tags : [],
          session: null,
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
      const { ids } = req.body;
      if (!Array.isArray(ids) || !ids.every((id: unknown) => typeof id === 'string')) {
        res.status(400).json({ error: 'ids must be an array of strings' });
        return;
      }

      const items = await withLock(req.params.workspace, async () => {
        const checklist = await readChecklist(todosDir, req.params.workspace);
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
      const log = await readLog(todosDir, req.params.workspace);
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

      const { workspace } = req.params;
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
      const log = await readLog(todosDir, req.params.workspace);
      const entries = log.entries.filter((e) => e.itemIds.includes(req.params.id));
      res.json({ workspace: log.workspace, entries });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to get log' });
    }
  });

  // GET /:workspace/:id — single item with log
  router.get('/:workspace/:id', async (req, res) => {
    try {
      const checklist = await readChecklist(todosDir, req.params.workspace);
      const item = checklist.items.find((i) => i.id === req.params.id);
      if (!item) {
        res.status(404).json({ error: `Todo "${req.params.id}" not found` });
        return;
      }
      const log = await readLog(todosDir, req.params.workspace);
      const logEntries = log.entries.filter((e) => e.itemIds.includes(req.params.id));
      res.json({ ...item, log: logEntries });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to get todo' });
    }
  });

  // PATCH /:workspace/:id — update description or tags
  router.patch('/:workspace/:id', async (req, res) => {
    try {
      const result = await withLock(req.params.workspace, async () => {
        const checklist = await readChecklist(todosDir, req.params.workspace);
        const item = checklist.items.find((i) => i.id === req.params.id);
        if (!item) return null;
        if (req.body.description !== undefined) item.description = req.body.description;
        if (Array.isArray(req.body.tags)) item.tags = req.body.tags;
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
      const deleted = await withLock(req.params.workspace, async () => {
        const checklist = await readChecklist(todosDir, req.params.workspace);
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
      const result = await withLock(req.params.workspace, async () => {
        const checklist = await readChecklist(todosDir, req.params.workspace);
        const item = checklist.items.find((i) => i.id === req.params.id);
        if (!item) return { error: 'not_found' as const };
        if (item.status === 'in_progress') return { error: 'conflict' as const, session: item.session };
        item.status = 'in_progress';
        item.session = req.body.session || null;
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
      const result = await withLock(req.params.workspace, async () => {
        const checklist = await readChecklist(todosDir, req.params.workspace);
        const item = checklist.items.find((i) => i.id === req.params.id);
        if (!item) return null;
        item.status = 'completed';
        item.session = null;
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
        await appendLogEntry(todosDir, req.params.workspace, entry);
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
      const result = await withLock(req.params.workspace, async () => {
        const checklist = await readChecklist(todosDir, req.params.workspace);
        const item = checklist.items.find((i) => i.id === req.params.id);
        if (!item) return null;
        item.status = 'blocked';
        item.session = null;
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
        await appendLogEntry(todosDir, req.params.workspace, entry);
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
      const result = await withLock(req.params.workspace, async () => {
        const checklist = await readChecklist(todosDir, req.params.workspace);
        const item = checklist.items.find((i) => i.id === req.params.id);
        if (!item) return null;
        item.status = 'open';
        item.session = null;
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

  // POST /:workspace/:id/unblock
  router.post('/:workspace/:id/unblock', async (req, res) => {
    try {
      const result = await withLock(req.params.workspace, async () => {
        const checklist = await readChecklist(todosDir, req.params.workspace);
        const item = checklist.items.find((i) => i.id === req.params.id);
        if (!item) return null;
        item.status = 'open';
        item.session = null;
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
