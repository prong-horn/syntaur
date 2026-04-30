import { Command } from 'commander';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { todosDir as getTodosDir, projectTodosDir, todoPlanDir } from '../utils/paths.js';
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
  .description('Promote one or more todos to a new or existing assignment')
  .argument('<ids...>', 'Todo short IDs')
  .option('--new-assignment', 'Create a new assignment from the todos (requires --to-project)')
  .option('--to-assignment <target>', 'Append todos to an existing assignment (project/slug or UUID)')
  .option('--to-project <slug>', 'Target project for the new assignment')
  .option('--title <title>', 'Title for the new assignment (required if multiple ids in --new-assignment mode)')
  .option('--type <type>', 'Type for the new assignment (e.g. feature, bug)')
  .option('--priority <level>', 'Priority for the new assignment (low|medium|high|critical)')
  .option('--keep-source', 'Do not mark source todos as completed')
  .option('--workspace <slug>', 'Source workspace slug')
  .option('--project <slug>', 'Source project slug (mutually exclusive with --workspace/--global)')
  .option('--global', 'Use global todos')
  .action(async (ids: string[], options) => {
    try {
      await promoteTodos(ids, options);
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

interface PromoteOptions {
  newAssignment?: boolean;
  toAssignment?: string;
  toProject?: string;
  title?: string;
  type?: string;
  priority?: string;
  keepSource?: boolean;
  workspace?: string;
  project?: string;
  global?: boolean;
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function promoteTodos(ids: string[], options: PromoteOptions): Promise<void> {
  if (ids.length === 0) {
    throw new Error('Provide at least one todo id.');
  }
  const modeCount = [Boolean(options.newAssignment), Boolean(options.toAssignment)].filter(Boolean).length;
  if (modeCount !== 1) {
    throw new Error('Specify exactly one of --new-assignment or --to-assignment <target>.');
  }
  if (options.newAssignment && !options.toProject) {
    throw new Error('--new-assignment requires --to-project <slug>.');
  }

  const scope = await resolveScope({
    project: options.project,
    workspace: options.workspace,
    global: options.global,
  });
  const todosPath = scope.todosPath;
  const workspace = scope.id;
  const checklist = await readChecklist(todosPath, workspace);

  const todos = ids.map((id) => {
    const item = findItem(checklist.items, id);
    if (!item) throw new Error(`Todo [t:${id}] not found in scope ${describeScope(scope)}.`);
    if (item.status === 'completed') {
      throw new Error(`Todo [t:${id}] is already completed; cannot promote.`);
    }
    return item;
  });

  const scopeLabel = describeScope(scope);

  if (options.newAssignment) {
    if (todos.length > 1 && !options.title) {
      throw new Error('--title is required when promoting multiple todos to a new assignment.');
    }
    const title = options.title || todos[0].description;
    const { createAssignmentCommand } = await import('./create-assignment.js');
    const validPriorities = ['low', 'medium', 'high', 'critical'] as const;
    type Priority = typeof validPriorities[number];
    const priority: Priority | undefined =
      options.priority && (validPriorities as readonly string[]).includes(options.priority)
        ? (options.priority as Priority)
        : undefined;
    const result = await createAssignmentCommand(title, {
      project: options.toProject!,
      type: options.type,
      priority,
      withTodos: true,
      silent: true,
    });

    await injectPromotedTodos(result.assignmentDir, todos, scopeLabel);

    if (!options.keepSource) {
      await markPromotedComplete(todos, todosPath, workspace, checklist, scope, `Promoted to assignment ${result.projectSlug}/${result.slug}`);
    }

    console.log(`Promoted ${todos.length} todo(s) to new assignment ${result.projectSlug}/${result.slug}`);
    console.log(`  ${result.assignmentDir}`);
    return;
  }

  // --to-assignment mode
  const target = options.toAssignment!;
  const { resolve: resolvePath } = await import('node:path');
  const { readConfig } = await import('../utils/config.js');
  const { assignmentsDir: assignmentsDirFn } = await import('../utils/paths.js');
  const config = await readConfig();

  let assignmentDir: string;
  let displayRef: string;
  if (target.includes('/')) {
    const parts = target.split('/');
    if (parts.length !== 2 || !isValidSlug(parts[0]) || !isValidSlug(parts[1])) {
      throw new Error(`Invalid --to-assignment target "${target}". Use <project>/<slug> or a bare UUID.`);
    }
    assignmentDir = resolvePath(config.defaultProjectDir, parts[0], 'assignments', parts[1]);
    displayRef = `${parts[0]}/${parts[1]}`;
  } else if (UUID_REGEX.test(target)) {
    assignmentDir = resolvePath(assignmentsDirFn(), target);
    displayRef = target;
  } else {
    throw new Error(`Invalid --to-assignment target "${target}". Use <project>/<slug> or a bare UUID.`);
  }

  const { fileExists } = await import('../utils/fs.js');
  const assignmentMdPath = resolvePath(assignmentDir, 'assignment.md');
  if (!(await fileExists(assignmentMdPath))) {
    throw new Error(`Target assignment not found: ${assignmentMdPath}`);
  }

  await injectPromotedTodos(assignmentDir, todos, scopeLabel);

  if (!options.keepSource) {
    await markPromotedComplete(todos, todosPath, workspace, checklist, scope, `Promoted to assignment ${displayRef}`);
  }

  console.log(`Promoted ${todos.length} todo(s) to existing assignment ${displayRef}`);
}

function describeScope(scope: Scope): string {
  if (scope.kind === 'project') return `project:${scope.id}`;
  if (scope.id === '_global') return '_global';
  return `workspace:${scope.id}`;
}

async function injectPromotedTodos(
  assignmentDir: string,
  todos: TodoItem[],
  scopeLabel: string,
): Promise<void> {
  const { resolve: resolvePath } = await import('node:path');
  const { readFile } = await import('node:fs/promises');
  const { writeFileForce } = await import('../utils/fs.js');
  const { appendTodosToAssignmentBody, touchAssignmentUpdated } = await import('../utils/assignment-todos.js');
  const { nowTimestamp } = await import('../utils/timestamp.js');

  const assignmentMdPath = resolvePath(assignmentDir, 'assignment.md');
  let content = await readFile(assignmentMdPath, 'utf-8');
  content = appendTodosToAssignmentBody(
    content,
    todos.map((t) => ({
      description: t.description,
      trace: `promoted from t:${t.id} in ${scopeLabel}`,
    })),
  );
  content = touchAssignmentUpdated(content, nowTimestamp());
  await writeFileForce(assignmentMdPath, content);
}

async function markPromotedComplete(
  todos: TodoItem[],
  todosPath: string,
  workspace: string,
  checklist: { items: TodoItem[] },
  _scope: Scope,
  summary: string,
): Promise<void> {
  for (const item of todos) {
    item.status = 'completed';
    item.session = null;
    touchItem(item);
  }
  await writeChecklist(todosPath, checklist as never);

  for (const item of todos) {
    const entry: LogEntry = {
      timestamp: nowISO(),
      itemIds: [item.id],
      items: item.description,
      session: null,
      branch: item.branch || null,
      summary,
      blockers: null,
      status: null,
    };
    await appendLogEntry(todosPath, workspace, entry);
  }
}

todoCommand
  .command('plan')
  .description('Create or open a plan directory for a todo')
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

      const planDir = todoPlanDir(todosPath, workspace, id);
      await ensureDir(planDir);

      const { readdir } = await import('node:fs/promises');
      const existingFiles = (await readdir(planDir).catch(() => [])).filter((f) =>
        /^plan(?:-v\d+)?\.md$/.test(f),
      );

      let target: string;
      if (existingFiles.length === 0) {
        target = resolve(planDir, 'plan.md');
      } else {
        const versions = new Set<number>();
        for (const f of existingFiles) {
          if (f === 'plan.md') versions.add(1);
          const m = f.match(/^plan-v(\d+)\.md$/);
          if (m) versions.add(parseInt(m[1], 10));
        }
        let n = 2;
        while (versions.has(n)) n++;
        target = resolve(planDir, `plan-v${n}.md`);
      }

      if (!(await fileExists(target))) {
        const stub = `---\ntodo: t:${id}\nstatus: draft\ncreated: "${nowISO()}"\nupdated: "${nowISO()}"\n---\n\n# Plan for todo t:${id}\n\n${item.description}\n`;
        await writeFileForce(target, stub);
      }

      item.planDir = planDir;
      touchItem(item);
      await writeChecklist(todosPath, checklist);

      console.log(target);
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

todoCommand
  .command('move')
  .description('Move a todo between scopes (workspace ↔ project ↔ global) without converting it')
  .argument('<id>', 'Todo short ID')
  .option('--to-workspace <slug>', 'Target workspace slug')
  .option('--to-project <slug>', 'Target project slug')
  .option('--to-global', 'Move to global todos')
  .option('--workspace <slug>', 'Source workspace slug')
  .option('--project <slug>', 'Source project slug (mutually exclusive with --workspace/--global)')
  .option('--global', 'Source: global todos')
  .action(async (id: string, options) => {
    try {
      await moveTodo(id, options);
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

interface MoveOptions {
  toWorkspace?: string;
  toProject?: string;
  toGlobal?: boolean;
  workspace?: string;
  project?: string;
  global?: boolean;
}

async function moveTodo(id: string, options: MoveOptions): Promise<void> {
  const targetCount = [
    Boolean(options.toWorkspace),
    Boolean(options.toProject),
    Boolean(options.toGlobal),
  ].filter(Boolean).length;
  if (targetCount !== 1) {
    throw new Error('Specify exactly one of --to-workspace <slug>, --to-project <slug>, --to-global.');
  }

  const sourceScope = await resolveScope({
    project: options.project,
    workspace: options.workspace,
    global: options.global,
  });
  const targetScope = await resolveScope({
    project: options.toProject,
    workspace: options.toWorkspace,
    global: options.toGlobal,
  });

  if (sourceScope.kind === targetScope.kind && sourceScope.id === targetScope.id) {
    throw new Error('Source and target scopes are the same; nothing to move.');
  }

  const sourceChecklist = await readChecklist(sourceScope.todosPath, sourceScope.id);
  const targetChecklist =
    sourceScope.todosPath === targetScope.todosPath && sourceScope.id === targetScope.id
      ? sourceChecklist
      : await readChecklist(targetScope.todosPath, targetScope.id);

  const idx = sourceChecklist.items.findIndex((i) => i.id === id);
  if (idx === -1) {
    throw new Error(`Todo [t:${id}] not found in scope ${describeScope(sourceScope)}.`);
  }
  const item = sourceChecklist.items[idx];

  if (targetChecklist.items.some((i) => i.id === id)) {
    throw new Error(`Todo id [t:${id}] already exists in target scope ${describeScope(targetScope)}; refusing to move (collision).`);
  }

  // Plan-dir relocation: re-resolve under the target scope and rename on disk.
  if (item.planDir) {
    const newPlanDir = todoPlanDir(targetScope.todosPath, targetScope.id, id);
    if (await fileExists(newPlanDir)) {
      throw new Error(`Plan directory already exists at target: ${newPlanDir}; refusing to move.`);
    }
    const { rename, mkdir } = await import('node:fs/promises');
    const { dirname } = await import('node:path');
    await mkdir(dirname(newPlanDir), { recursive: true });
    await rename(item.planDir, newPlanDir);
    item.planDir = newPlanDir;
  }

  // Splice from source, append to target. Preserve every other field verbatim
  // (id, tags, branch, worktreePath, createdAt, updatedAt). Do NOT touchItem.
  sourceChecklist.items.splice(idx, 1);
  targetChecklist.items.push(item);

  await writeChecklist(sourceScope.todosPath, sourceChecklist);
  if (targetChecklist !== sourceChecklist) {
    await writeChecklist(targetScope.todosPath, targetChecklist);
  }

  const sourceLabel = describeScope(sourceScope);
  const targetLabel = describeScope(targetScope);
  const ts = nowISO();
  const sourceEntry: LogEntry = {
    timestamp: ts,
    itemIds: [id],
    items: item.description,
    session: null,
    branch: item.branch || null,
    summary: `Moved to ${targetLabel}`,
    blockers: null,
    status: null,
  };
  const targetEntry: LogEntry = {
    timestamp: ts,
    itemIds: [id],
    items: item.description,
    session: null,
    branch: item.branch || null,
    summary: `Moved from ${sourceLabel}`,
    blockers: null,
    status: null,
  };
  await appendLogEntry(sourceScope.todosPath, sourceScope.id, sourceEntry);
  await appendLogEntry(targetScope.todosPath, targetScope.id, targetEntry);

  console.log(`Moved [t:${id}] from ${sourceLabel} to ${targetLabel}`);
}
