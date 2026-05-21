import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { createProjectCommand } from '../commands/create-project.js';
import { createAssignmentCommand } from '../commands/create-assignment.js';
import { executeTransition } from '../lifecycle/index.js';
import { readChecklist, writeChecklist, appendLogEntry } from '../todos/parser.js';
import type { TodoItem, LogEntry } from '../todos/types.js';

let testDir: string;
let todosDir: string;
let projectsDir: string;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'syntaur-lifecycle-linked-'));
  todosDir = resolve(testDir, 'todos');
  projectsDir = resolve(testDir, 'projects');
  await mkdir(todosDir, { recursive: true });
  await mkdir(projectsDir, { recursive: true });
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

function makeTodo(id: string, description: string, overrides: Partial<TodoItem> = {}): TodoItem {
  return {
    id,
    description,
    status: 'in_progress',
    tags: [],
    session: null,
    branch: null,
    worktreePath: null,
    createdAt: '2026-05-16T10:00:00Z',
    updatedAt: '2026-05-16T10:00:00Z',
    planDir: null,
    linkedAssignmentId: null,
    linkedAssignmentRef: null,
    bundleId: null,
    ...overrides,
  };
}

async function seedLinkedTodo(
  workspace: string,
  todo: TodoItem,
  autoCompleted = false,
): Promise<void> {
  await writeChecklist(todosDir, {
    workspace,
    archiveInterval: 'weekly',
    items: [todo],
  });
  if (autoCompleted) {
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      itemIds: [todo.id],
      items: todo.description,
      session: null,
      branch: null,
      summary: `Auto-completed: linked assignment ${todo.linkedAssignmentRef} closed`,
      blockers: null,
      status: null,
    };
    await appendLogEntry(todosDir, workspace, entry);
  }
}

describe('lifecycle linked-todos hook', () => {
  it('auto-completes linked todos when the assignment transitions to completed', async () => {
    await createProjectCommand('Test Project', { dir: projectsDir });
    const created = await createAssignmentCommand('Task', {
      project: 'test-project',
      dir: projectsDir,
      silent: true,
    });
    // Start it so we can complete it.
    const projectDir = resolve(projectsDir, 'test-project');
    await executeTransition(projectDir, created.slug, 'start', {});

    // Seed a workspace todo linked to this assignment.
    await seedLinkedTodo('_global', makeTodo('aaaa', 'work item', {
      status: 'in_progress',
      linkedAssignmentId: created.id,
      linkedAssignmentRef: `test-project/${created.slug}`,
    }));

    await executeTransition(projectDir, created.slug, 'complete', {
      linkedTodosLookup: { todosDir, projectsDir },
    });

    const checklist = await readChecklist(todosDir, '_global');
    expect(checklist.items[0].status).toBe('completed');
    const log = await readFile(resolve(todosDir, '_global-log.md'), 'utf-8');
    expect(log).toContain('Auto-completed: linked assignment');
  });

  it('auto-reopens linked todos that were auto-completed when the assignment is reopened', async () => {
    await createProjectCommand('Test Project', { dir: projectsDir });
    const created = await createAssignmentCommand('Task', {
      project: 'test-project',
      dir: projectsDir,
      silent: true,
    });
    const projectDir = resolve(projectsDir, 'test-project');
    await executeTransition(projectDir, created.slug, 'start', {});

    // Seed a linked todo as `completed` with an auto-complete log entry — this
    // simulates the post-auto-complete state.
    await seedLinkedTodo(
      '_global',
      makeTodo('bbbb', 'auto-completed item', {
        status: 'completed',
        linkedAssignmentId: created.id,
        linkedAssignmentRef: `test-project/${created.slug}`,
      }),
      /* autoCompleted */ true,
    );

    // Transition the assignment to completed (already in the right state for
    // the source todo, but we need the assignment in `completed` to reopen).
    await executeTransition(projectDir, created.slug, 'complete', {});

    // Now reopen.
    await executeTransition(projectDir, created.slug, 'reopen', {
      linkedTodosLookup: { todosDir, projectsDir },
    });

    const checklist = await readChecklist(todosDir, '_global');
    expect(checklist.items[0].status).toBe('in_progress');
    const log = await readFile(resolve(todosDir, '_global-log.md'), 'utf-8');
    expect(log).toContain('Auto-reopened: linked assignment');
  });

  it('leaves manually-completed linked todos untouched on reopen', async () => {
    await createProjectCommand('Test Project', { dir: projectsDir });
    const created = await createAssignmentCommand('Task', {
      project: 'test-project',
      dir: projectsDir,
      silent: true,
    });
    const projectDir = resolve(projectsDir, 'test-project');
    await executeTransition(projectDir, created.slug, 'start', {});

    // Seed a linked todo as `completed` but with NO auto-complete log entry
    // (i.e. the user marked it complete by hand after the auto-complete fired,
    // or it never auto-completed). Reopen must leave it alone.
    await seedLinkedTodo(
      '_global',
      makeTodo('cccc', 'manually-completed item', {
        status: 'completed',
        linkedAssignmentId: created.id,
        linkedAssignmentRef: `test-project/${created.slug}`,
      }),
      /* autoCompleted */ false,
    );

    await executeTransition(projectDir, created.slug, 'complete', {});
    await executeTransition(projectDir, created.slug, 'reopen', {
      linkedTodosLookup: { todosDir, projectsDir },
    });

    const checklist = await readChecklist(todosDir, '_global');
    // Untouched: still completed.
    expect(checklist.items[0].status).toBe('completed');
  });

  it('auto-completes a project-scoped linked todo (per-project todos/<slug>.md)', async () => {
    await createProjectCommand('Test Project', { dir: projectsDir });
    const created = await createAssignmentCommand('Task', {
      project: 'test-project',
      dir: projectsDir,
      silent: true,
    });
    const projectDir = resolve(projectsDir, 'test-project');
    await executeTransition(projectDir, created.slug, 'start', {});

    // Seed a project-scoped todo at <projectsDir>/test-project/todos/test-project.md
    const projectTd = resolve(projectsDir, 'test-project', 'todos');
    await mkdir(projectTd, { recursive: true });
    await writeChecklist(projectTd, {
      workspace: 'test-project',
      archiveInterval: 'weekly',
      items: [makeTodo('eeee', 'project work', {
        status: 'in_progress',
        linkedAssignmentId: created.id,
        linkedAssignmentRef: `test-project/${created.slug}`,
      })],
    });

    await executeTransition(projectDir, created.slug, 'complete', {
      linkedTodosLookup: { todosDir, projectsDir },
    });

    const checklist = await readChecklist(projectTd, 'test-project');
    expect(checklist.items[0].status).toBe('completed');
  });

  it('is a no-op when linkedTodosLookup is not provided', async () => {
    await createProjectCommand('Test Project', { dir: projectsDir });
    const created = await createAssignmentCommand('Task', {
      project: 'test-project',
      dir: projectsDir,
      silent: true,
    });
    const projectDir = resolve(projectsDir, 'test-project');
    await executeTransition(projectDir, created.slug, 'start', {});

    await seedLinkedTodo('_global', makeTodo('dddd', 'work', {
      status: 'in_progress',
      linkedAssignmentId: created.id,
      linkedAssignmentRef: `test-project/${created.slug}`,
    }));

    await executeTransition(projectDir, created.slug, 'complete', {
      // no linkedTodosLookup
    });

    const checklist = await readChecklist(todosDir, '_global');
    // Untouched.
    expect(checklist.items[0].status).toBe('in_progress');
  });
});
