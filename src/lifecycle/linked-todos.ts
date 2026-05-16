import { readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  readChecklist,
  writeChecklist,
  readLog,
  appendLogEntry,
} from '../todos/parser.js';
import { fileExists } from '../utils/fs.js';
import type { TodoItem, LogEntry } from '../todos/types.js';

export interface LinkedTodosLookup {
  /** Workspace todos dir (e.g. ~/.syntaur/todos). */
  todosDir: string;
  /** Projects root dir (e.g. ~/.syntaur/projects). Used to scan per-project todo checklists. */
  projectsDir: string;
}

export interface LinkedTodosResult {
  completed?: number;
  reopened?: number;
  touched: Array<{ workspace: string; id: string }>;
}

const AUTO_COMPLETE_PREFIX = 'Auto-completed: linked assignment ';
const AUTO_REOPEN_PREFIX = 'Auto-reopened: linked assignment ';

function touchItem(item: TodoItem): void {
  const now = new Date().toISOString();
  if (item.createdAt === null) item.createdAt = now;
  item.updatedAt = now;
}

async function listWorkspaceTodosFiles(todosDir: string): Promise<string[]> {
  if (!(await fileExists(todosDir))) return [];
  const files = await readdir(todosDir).catch(() => [] as string[]);
  return files
    .filter((f): f is string => typeof f === 'string')
    .filter((f) => f.endsWith('.md') && !f.endsWith('-log.md'))
    .map((f) => f.replace(/\.md$/, ''));
}

async function listProjectTodosWorkspaces(projectsDir: string): Promise<Array<{ projectSlug: string; todosDir: string; workspace: string }>> {
  if (!(await fileExists(projectsDir))) return [];
  const projects = await readdir(projectsDir).catch(() => [] as string[]);
  const result: Array<{ projectSlug: string; todosDir: string; workspace: string }> = [];
  for (const p of projects) {
    if (typeof p !== 'string') continue;
    const todosDir = resolve(projectsDir, p, 'todos');
    if (await fileExists(resolve(todosDir, `${p}.md`))) {
      result.push({ projectSlug: p, todosDir, workspace: p });
    }
  }
  return result;
}

/**
 * Returns true if the most recent log entry for this item has summary
 * starting with `prefix`. Used to identify items that were auto-completed
 * (so we know it is safe to auto-reopen them) and items that were already
 * auto-reopened (idempotency).
 */
async function lastLogEntryMatches(
  todosDir: string,
  workspace: string,
  itemId: string,
  prefix: string,
): Promise<boolean> {
  const log = await readLog(todosDir, workspace);
  // Scan in reverse: most recent matching entry for this item.
  for (let i = log.entries.length - 1; i >= 0; i--) {
    const entry = log.entries[i];
    if (!entry.itemIds.includes(itemId)) continue;
    return entry.summary.startsWith(prefix);
  }
  return false;
}

export async function completeLinkedTodos(
  lookup: LinkedTodosLookup,
  assignmentId: string,
  assignmentRef: string,
): Promise<LinkedTodosResult> {
  const touched: Array<{ workspace: string; id: string }> = [];

  const workspaces = await listWorkspaceTodosFiles(lookup.todosDir);
  const projectWorkspaces = await listProjectTodosWorkspaces(lookup.projectsDir);
  const all: Array<{ todosDir: string; workspace: string }> = [
    ...workspaces.map((workspace) => ({ todosDir: lookup.todosDir, workspace })),
    ...projectWorkspaces.map(({ todosDir, workspace }) => ({ todosDir, workspace })),
  ];

  for (const { todosDir, workspace } of all) {
    const checklist = await readChecklist(todosDir, workspace);
    const idsTouched: string[] = [];
    for (const item of checklist.items) {
      if (item.linkedAssignmentId !== assignmentId) continue;
      if (item.status === 'completed') continue;
      item.status = 'completed';
      item.session = null;
      touchItem(item);
      idsTouched.push(item.id);
    }
    if (idsTouched.length === 0) continue;
    await writeChecklist(todosDir, checklist);
    for (const id of idsTouched) {
      const entry: LogEntry = {
        timestamp: new Date().toISOString(),
        itemIds: [id],
        items: checklist.items.find((i) => i.id === id)?.description ?? '',
        session: null,
        branch: null,
        summary: `${AUTO_COMPLETE_PREFIX}${assignmentRef} closed`,
        blockers: null,
        status: null,
      };
      await appendLogEntry(todosDir, workspace, entry);
      touched.push({ workspace, id });
    }
  }

  return { completed: touched.length, touched };
}

export async function reopenLinkedTodos(
  lookup: LinkedTodosLookup,
  assignmentId: string,
  assignmentRef: string,
): Promise<LinkedTodosResult> {
  const touched: Array<{ workspace: string; id: string }> = [];

  const workspaces = await listWorkspaceTodosFiles(lookup.todosDir);
  const projectWorkspaces = await listProjectTodosWorkspaces(lookup.projectsDir);
  const all: Array<{ todosDir: string; workspace: string }> = [
    ...workspaces.map((workspace) => ({ todosDir: lookup.todosDir, workspace })),
    ...projectWorkspaces.map(({ todosDir, workspace }) => ({ todosDir, workspace })),
  ];

  for (const { todosDir, workspace } of all) {
    const checklist = await readChecklist(todosDir, workspace);
    const candidates = checklist.items.filter(
      (i) => i.linkedAssignmentId === assignmentId && i.status === 'completed',
    );
    if (candidates.length === 0) continue;
    const idsTouched: string[] = [];
    for (const item of candidates) {
      // Manual-completion guard: only auto-reopen items whose most recent log
      // entry is the auto-complete marker. If the user marked them complete
      // by hand afterwards, leave them alone.
      const wasAutoCompleted = await lastLogEntryMatches(
        todosDir,
        workspace,
        item.id,
        AUTO_COMPLETE_PREFIX,
      );
      if (!wasAutoCompleted) continue;
      item.status = 'in_progress';
      item.session = null;
      touchItem(item);
      idsTouched.push(item.id);
    }
    if (idsTouched.length === 0) continue;
    await writeChecklist(todosDir, checklist);
    for (const id of idsTouched) {
      const entry: LogEntry = {
        timestamp: new Date().toISOString(),
        itemIds: [id],
        items: checklist.items.find((i) => i.id === id)?.description ?? '',
        session: null,
        branch: null,
        summary: `${AUTO_REOPEN_PREFIX}${assignmentRef} reopened`,
        blockers: null,
        status: null,
      };
      await appendLogEntry(todosDir, workspace, entry);
      touched.push({ workspace, id });
    }
  }

  return { reopened: touched.length, touched };
}
