import { Command } from 'commander';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { todosDir as getTodosDir, projectTodosDir } from '../utils/paths.js';
import {
  readChecklist,
  writeChecklist,
  readLog,
  appendLogEntry,
  generateUniqueId,
  computeCounts,
  checklistPath,
  logPath,
  archivePath,
} from '../todos/parser.js';
import { ensureDir, fileExists, writeFileForce } from '../utils/fs.js';
import { readConfig } from '../utils/config.js';
import { isValidSlug } from '../utils/slug.js';
import type { TodoItem, LogEntry } from '../todos/types.js';

const WORKSPACE_REGEX = /^[a-z0-9_][a-z0-9-]*$/;

type ScopeOptions = { project?: string; workspace?: string; global?: boolean };
type Scope = { kind: 'workspace'; id: string; todosPath: string } | { kind: 'project'; id: string; todosPath: string };

async function resolveScope(options: ScopeOptions): Promise<Scope> {
  const flagCount = [Boolean(options.project), Boolean(options.workspace), Boolean(options.global)].filter(Boolean).length;
  if (flagCount > 1) {
    throw new Error('Use at most one of --project, --workspace, --global.');
  }
  if (options.project) {
    if (!isValidSlug(options.project)) {
      throw new Error(`Invalid project slug: "${options.project}".`);
    }
    const config = await readConfig();
    const projectMd = resolve(config.defaultProjectDir, options.project, 'project.md');
    if (!(await fileExists(projectMd))) {
      throw new Error(`Project "${options.project}" not found.`);
    }
    return { kind: 'project', id: options.project, todosPath: projectTodosDir(config.defaultProjectDir, options.project) };
  }
  if (options.workspace) {
    if (!WORKSPACE_REGEX.test(options.workspace)) {
      throw new Error(`Invalid workspace name: "${options.workspace}". Use lowercase letters, numbers, hyphens, and underscores.`);
    }
    return { kind: 'workspace', id: options.workspace, todosPath: getTodosDir() };
  }
  return { kind: 'workspace', id: '_global', todosPath: getTodosDir() };
}

function nowISO(): string {
  return new Date().toISOString();
}

export const todoCommand = new Command('todo')
  .description('Manage quick todos');

todoCommand
  .command('add')
  .description('Add a new todo item')
  .argument('<description>', 'Todo description')
  .option('--tags <tags>', 'Comma-separated tags')
  .option('--workspace <slug>', 'Workspace slug')
  .option('--project <slug>', 'Project slug (mutually exclusive with --workspace/--global)')
  .option('--global', 'Use global todos')
  .action(async (description: string, options) => {
    try {
      const scope = await resolveScope(options);
      const todosPath = scope.todosPath;
      const workspace = scope.id;
      const checklist = await readChecklist(todosPath, workspace);
      const existingIds = new Set(checklist.items.map((i) => i.id));
      const id = generateUniqueId(existingIds);
      const tags = options.tags ? options.tags.split(',').map((t: string) => t.trim()) : [];

      const now = nowISO();
      const item: TodoItem = {
        id,
        description,
        status: 'open',
        tags,
        session: null,
        branch: null,
        worktreePath: null,
        createdAt: now,
        updatedAt: now,
        planDir: null,
      };
      checklist.items.push(item);
      await writeChecklist(todosPath, checklist);
      console.log(`Added todo [t:${id}]: ${description}`);
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

todoCommand
  .command('list')
  .description('List todo items')
  .option('--tag <tag>', 'Filter by tag')
  .option('--status <status>', 'Filter by status (open|in_progress|completed|blocked)')
  .option('--workspace <slug>', 'Workspace slug')
  .option('--project <slug>', 'Project slug (mutually exclusive with --workspace/--global)')
  .option('--global', 'Use global todos')
  .action(async (options) => {
    try {
      const scope = await resolveScope(options);
      const todosPath = scope.todosPath;
      const workspace = scope.id;
      const checklist = await readChecklist(todosPath, workspace);
      let items = checklist.items;

      if (options.tag) {
        items = items.filter((i) => i.tags.includes(options.tag));
      }
      if (options.status) {
        items = items.filter((i) => i.status === options.status);
      }

      if (items.length === 0) {
        console.log('No todos found.');
        return;
      }

      const statusIcons: Record<string, string> = {
        open: '[ ]',
        in_progress: '[>]',
        completed: '[x]',
        blocked: '[!]',
      };

      for (const item of items) {
        const icon = statusIcons[item.status] || '[ ]';
        const tagStr = item.tags.length > 0 ? ` ${item.tags.map((t) => `#${t}`).join(' ')}` : '';
        console.log(`${icon} ${item.description}${tagStr} [t:${item.id}]`);
      }

      const counts = computeCounts(items);
      console.log(`\n${counts.total} items: ${counts.open} open, ${counts.in_progress} active, ${counts.completed} done, ${counts.blocked} blocked`);
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

function findItem(items: TodoItem[], id: string): TodoItem | undefined {
  return items.find((i) => i.id === id);
}

function touchItem(item: TodoItem): void {
  const now = nowISO();
  if (item.createdAt === null) item.createdAt = now;
  item.updatedAt = now;
}

todoCommand
  .command('start')
  .description('Mark a todo as in-progress')
  .argument('<id>', 'Todo short ID (e.g. a3f1)')
  .option('--session <session>', 'Session ID')
  .option('--branch <branch>', 'Git branch the work happens on')
  .option('--worktree <path>', 'Worktree path the work happens in')
  .option('--workspace <slug>', 'Workspace slug')
  .option('--project <slug>', 'Project slug (mutually exclusive with --workspace/--global)')
  .option('--global', 'Use global todos')
  .action(async (id: string, options) => {
    try {
      const scope = await resolveScope(options);
      const todosPath = scope.todosPath;
      const workspace = scope.id;
      const checklist = await readChecklist(todosPath, workspace);
      const item = findItem(checklist.items, id);
      if (!item) {
        console.error(`Todo [t:${id}] not found.`);
        process.exit(1);
      }
      if (item.status === 'in_progress') {
        console.error(`Todo [t:${id}] is already in progress (session: ${item.session}).`);
        process.exit(1);
      }
      item.status = 'in_progress';
      item.session = options.session || null;
      if (options.branch) item.branch = options.branch;
      if (options.worktree) item.worktreePath = options.worktree;
      touchItem(item);
      await writeChecklist(todosPath, checklist);
      console.log(`Started [t:${id}]: ${item.description}`);
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

todoCommand
  .command('complete')
  .description('Mark a todo as completed')
  .argument('<id>', 'Todo short ID')
  .option('--summary <summary>', 'Completion summary')
  .option('--branch <branch>', 'Git branch name')
  .option('--session <session>', 'Session ID')
  .option('--workspace <slug>', 'Workspace slug')
  .option('--project <slug>', 'Project slug (mutually exclusive with --workspace/--global)')
  .option('--global', 'Use global todos')
  .action(async (id: string, options) => {
    try {
      const scope = await resolveScope(options);
      const todosPath = scope.todosPath;
      const workspace = scope.id;
      const checklist = await readChecklist(todosPath, workspace);
      const item = findItem(checklist.items, id);
      if (!item) {
        console.error(`Todo [t:${id}] not found.`);
        process.exit(1);
      }
      item.status = 'completed';
      item.session = null;
      touchItem(item);
      await writeChecklist(todosPath, checklist);

      const entry: LogEntry = {
        timestamp: nowISO(),
        itemIds: [id],
        items: item.description,
        session: options.session || null,
        branch: options.branch || item.branch || null,
        summary: options.summary || 'Completed.',
        blockers: null,
        status: null,
      };
      await appendLogEntry(todosPath, workspace, entry);
      console.log(`Completed [t:${id}]: ${item.description}`);
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

todoCommand
  .command('block')
  .description('Mark a todo as blocked')
  .argument('<id>', 'Todo short ID')
  .requiredOption('--reason <reason>', 'Blocking reason')
  .option('--session <session>', 'Session ID')
  .option('--workspace <slug>', 'Workspace slug')
  .option('--project <slug>', 'Project slug (mutually exclusive with --workspace/--global)')
  .option('--global', 'Use global todos')
  .action(async (id: string, options) => {
    try {
      const scope = await resolveScope(options);
      const todosPath = scope.todosPath;
      const workspace = scope.id;
      const checklist = await readChecklist(todosPath, workspace);
      const item = findItem(checklist.items, id);
      if (!item) {
        console.error(`Todo [t:${id}] not found.`);
        process.exit(1);
      }
      item.status = 'blocked';
      item.session = null;
      touchItem(item);
      await writeChecklist(todosPath, checklist);

      const entry: LogEntry = {
        timestamp: nowISO(),
        itemIds: [id],
        items: item.description,
        session: options.session || null,
        branch: null,
        summary: options.reason,
        blockers: options.reason,
        status: 'blocked',
      };
      await appendLogEntry(todosPath, workspace, entry);
      console.log(`Blocked [t:${id}]: ${item.description}`);
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

todoCommand
  .command('unblock')
  .description('Return a blocked todo to open')
  .argument('<id>', 'Todo short ID')
  .option('--workspace <slug>', 'Workspace slug')
  .option('--project <slug>', 'Project slug (mutually exclusive with --workspace/--global)')
  .option('--global', 'Use global todos')
  .action(async (id: string, options) => {
    try {
      const scope = await resolveScope(options);
      const todosPath = scope.todosPath;
      const workspace = scope.id;
      const checklist = await readChecklist(todosPath, workspace);
      const item = findItem(checklist.items, id);
      if (!item) {
        console.error(`Todo [t:${id}] not found.`);
        process.exit(1);
      }
      item.status = 'open';
      item.session = null;
      touchItem(item);
      await writeChecklist(todosPath, checklist);
      console.log(`Unblocked [t:${id}]: ${item.description}`);
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

todoCommand
  .command('delete')
  .description('Delete a todo item (no log entry)')
  .argument('<id>', 'Todo short ID')
  .option('--workspace <slug>', 'Workspace slug')
  .option('--project <slug>', 'Project slug (mutually exclusive with --workspace/--global)')
  .option('--global', 'Use global todos')
  .action(async (id: string, options) => {
    try {
      const scope = await resolveScope(options);
      const todosPath = scope.todosPath;
      const workspace = scope.id;
      const checklist = await readChecklist(todosPath, workspace);
      const idx = checklist.items.findIndex((i) => i.id === id);
      if (idx === -1) {
        console.error(`Todo [t:${id}] not found.`);
        process.exit(1);
      }
      const item = checklist.items[idx];
      checklist.items.splice(idx, 1);
      await writeChecklist(todosPath, checklist);
      console.log(`Deleted [t:${id}]: ${item.description}`);
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

todoCommand
  .command('edit')
  .description('Update a todo description')
  .argument('<id>', 'Todo short ID')
  .argument('<description>', 'New description')
  .option('--workspace <slug>', 'Workspace slug')
  .option('--project <slug>', 'Project slug (mutually exclusive with --workspace/--global)')
  .option('--global', 'Use global todos')
  .action(async (id: string, description: string, options) => {
    try {
      const scope = await resolveScope(options);
      const todosPath = scope.todosPath;
      const workspace = scope.id;
      const checklist = await readChecklist(todosPath, workspace);
      const item = findItem(checklist.items, id);
      if (!item) {
        console.error(`Todo [t:${id}] not found.`);
        process.exit(1);
      }
      item.description = description;
      touchItem(item);
      await writeChecklist(todosPath, checklist);
      console.log(`Updated [t:${id}]: ${description}`);
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

todoCommand
  .command('tag')
  .description('Modify tags on a todo')
  .argument('<id>', 'Todo short ID')
  .option('--add <tags>', 'Tags to add (comma-separated)')
  .option('--remove <tags>', 'Tags to remove (comma-separated)')
  .option('--workspace <slug>', 'Workspace slug')
  .option('--project <slug>', 'Project slug (mutually exclusive with --workspace/--global)')
  .option('--global', 'Use global todos')
  .action(async (id: string, options) => {
    try {
      const scope = await resolveScope(options);
      const todosPath = scope.todosPath;
      const workspace = scope.id;
      const checklist = await readChecklist(todosPath, workspace);
      const item = findItem(checklist.items, id);
      if (!item) {
        console.error(`Todo [t:${id}] not found.`);
        process.exit(1);
      }
      if (options.add) {
        const toAdd = options.add.split(',').map((t: string) => t.trim());
        for (const tag of toAdd) {
          if (!item.tags.includes(tag)) item.tags.push(tag);
        }
      }
      if (options.remove) {
        const toRemove = options.remove.split(',').map((t: string) => t.trim());
        item.tags = item.tags.filter((t) => !toRemove.includes(t));
      }
      touchItem(item);
      await writeChecklist(todosPath, checklist);
      console.log(`Tags for [t:${id}]: ${item.tags.map((t) => `#${t}`).join(' ') || '(none)'}`);
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

todoCommand
  .command('log')
  .description('Show log entries')
  .argument('[id]', 'Optional todo short ID to filter')
  .option('--workspace <slug>', 'Workspace slug')
  .option('--project <slug>', 'Project slug (mutually exclusive with --workspace/--global)')
  .option('--global', 'Use global todos')
  .action(async (id: string | undefined, options) => {
    try {
      const scope = await resolveScope(options);
      const todosPath = scope.todosPath;
      const workspace = scope.id;
      const log = await readLog(todosPath, workspace);
      let entries = log.entries;

      if (id) {
        entries = entries.filter((e) => e.itemIds.includes(id));
      }

      if (entries.length === 0) {
        console.log('No log entries found.');
        return;
      }

      for (const entry of entries) {
        console.log(`\n${entry.timestamp} — ${entry.itemIds.map((i) => `t:${i}`).join(', ')}`);
        if (entry.items) console.log(`  Items: ${entry.items}`);
        if (entry.session) console.log(`  Session: ${entry.session}`);
        if (entry.branch) console.log(`  Branch: ${entry.branch}`);
        console.log(`  Summary: ${entry.summary}`);
        if (entry.blockers) console.log(`  Blockers: ${entry.blockers}`);
      }
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

todoCommand
  .command('archive')
  .description('Archive completed todos and their log entries')
  .option('--workspace <slug>', 'Workspace slug')
  .option('--project <slug>', 'Project slug (mutually exclusive with --workspace/--global)')
  .option('--global', 'Use global todos')
  .action(async (options) => {
    try {
      const scope = await resolveScope(options);
      const todosPath = scope.todosPath;
      const workspace = scope.id;
      const checklist = await readChecklist(todosPath, workspace);
      const log = await readLog(todosPath, workspace);

      const completedIds = new Set(
        checklist.items.filter((i) => i.status === 'completed').map((i) => i.id),
      );

      if (completedIds.size === 0) {
        console.log('No completed items to archive.');
        return;
      }

      // Collect log entries for completed items
      const toArchive = log.entries.filter((e) =>
        e.itemIds.every((id) => completedIds.has(id)),
      );

      // Write archive file
      const archFile = archivePath(todosPath, workspace, checklist.archiveInterval);
      await ensureDir(resolve(todosPath, 'archive'));
      let archContent = '';
      if (await fileExists(archFile)) {
        archContent = await readFile(archFile, 'utf-8');
        archContent = archContent.trimEnd() + '\n\n';
      } else {
        archContent = `---\nworkspace: ${workspace}\n---\n\n# Archive\n\n`;
      }

      // Add completed items as reference
      const completedItems = checklist.items.filter((i) => completedIds.has(i.id));
      for (const item of completedItems) {
        archContent += `- [x] ${item.description} ${item.tags.map((t) => `#${t}`).join(' ')} [t:${item.id}]\n`;
      }
      archContent += '\n';

      // Add log entries
      for (const entry of toArchive) {
        archContent += `### ${entry.timestamp} — ${entry.itemIds.map((i) => `t:${i}`).join(', ')}\n`;
        if (entry.items) archContent += `**Items:** ${entry.items}\n`;
        if (entry.session) archContent += `**Session:** ${entry.session}\n`;
        if (entry.branch) archContent += `**Branch:** ${entry.branch}\n`;
        if (entry.summary) archContent += `**Summary:** ${entry.summary}\n`;
        if (entry.blockers) archContent += `**Blockers:** ${entry.blockers}\n`;
        archContent += '\n';
      }

      await writeFileForce(archFile, archContent);

      // Remove completed items from checklist
      checklist.items = checklist.items.filter((i) => !completedIds.has(i.id));
      await writeChecklist(todosPath, checklist);

      // Remove archived entries from log using Set identity (index-based)
      const archivedEntries = new Set(toArchive);
      log.entries = log.entries.filter((e) => !archivedEntries.has(e));
      // Rewrite the log
      if (log.entries.length > 0) {
        let logContent = `---\nworkspace: ${workspace}\n---\n\n# Todo Log\n\n`;
        for (const entry of log.entries) {
          logContent += `### ${entry.timestamp} — ${entry.itemIds.map((i) => `t:${i}`).join(', ')}\n`;
          if (entry.items) logContent += `**Items:** ${entry.items}\n`;
          if (entry.session) logContent += `**Session:** ${entry.session}\n`;
          if (entry.branch) logContent += `**Branch:** ${entry.branch}\n`;
          if (entry.summary) logContent += `**Summary:** ${entry.summary}\n`;
          if (entry.blockers) logContent += `**Blockers:** ${entry.blockers}\n`;
          logContent += '\n';
        }
        await writeFileForce(logPath(todosPath, workspace), logContent);
      } else {
        await writeFileForce(logPath(todosPath, workspace), `---\nworkspace: ${workspace}\n---\n\n# Todo Log\n`);
      }

      console.log(`Archived ${completedIds.size} completed items and ${toArchive.length} log entries.`);
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

todoCommand
  .command('promote')
  .description('Promote a todo to a full assignment')
  .argument('<id>', 'Todo short ID')
  .requiredOption('--to-project <slug>', 'Target project slug for the new assignment')
  .option('--workspace <slug>', 'Source workspace slug')
  .option('--project <slug>', 'Source project slug (mutually exclusive with --workspace/--global)')
  .option('--global', 'Use global todos')
  .action(async (id: string, options) => {
    try {
      const scope = await resolveScope(options);
      const todosPath = scope.todosPath;
      const workspace = scope.id;
      const checklist = await readChecklist(todosPath, workspace);
      const item = findItem(checklist.items, id);
      if (!item) {
        console.error(`Todo [t:${id}] not found.`);
        process.exit(1);
      }

      // Mark as completed with promotion note
      item.status = 'completed';
      item.session = null;
      touchItem(item);
      await writeChecklist(todosPath, checklist);

      const entry: LogEntry = {
        timestamp: nowISO(),
        itemIds: [id],
        items: item.description,
        session: null,
        branch: null,
        summary: `Promoted to assignment in project: ${options.toProject}`,
        blockers: null,
        status: null,
      };
      await appendLogEntry(todosPath, workspace, entry);

      console.log(`Promoted [t:${id}] to assignment in project "${options.toProject}".`);
      console.log(`Run: syntaur create-assignment --project ${options.toProject} "${item.description}"`);
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });
