import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { promoteTodosToNewAssignment, parsePromoteTarget } from '../utils/promote-todos.js';
import { readChecklist, writeChecklist } from '../todos/parser.js';
import { projectTodosDir } from '../utils/paths.js';
import type { TodoItem } from '../todos/types.js';

let testDir: string;
let projectsDir: string;
let todosDir: string;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'syntaur-promote-helper-'));
  projectsDir = resolve(testDir, 'projects');
  todosDir = resolve(testDir, 'todos');
  await mkdir(projectsDir, { recursive: true });
  await mkdir(todosDir, { recursive: true });
  await writeFile(
    resolve(testDir, 'config.md'),
    `---\nversion: "2.0"\ndefaultProjectDir: ${projectsDir}\nonboarding:\n  completed: true\n---\n`,
  );
  process.env.SYNTAUR_HOME = testDir;
});

afterEach(async () => {
  delete process.env.SYNTAUR_HOME;
  await rm(testDir, { recursive: true, force: true });
});

async function seedProject(slug: string): Promise<void> {
  await mkdir(resolve(projectsDir, slug), { recursive: true });
  await writeFile(
    resolve(projectsDir, slug, 'project.md'),
    `---\nid: ${slug}-id\nslug: ${slug}\ntitle: ${slug}\n---\n# ${slug}\n`,
  );
}

function makeTodo(id: string, description: string): TodoItem {
  return {
    id,
    description,
    status: 'open',
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
  };
}

describe('parsePromoteTarget', () => {
  it('accepts a valid project slug', () => {
    const r = parsePromoteTarget({ project: 'alpha' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.target).toEqual({ project: 'alpha' });
  });

  it('rejects an invalid project slug as a client error (not 500)', () => {
    const r = parsePromoteTarget({ project: 'Bad Slug' });
    expect(r.ok).toBe(false);
  });

  it('accepts oneOff with a valid workspaceGroup', () => {
    const r = parsePromoteTarget({ oneOff: true, workspaceGroup: 'syntaur' });
    expect(r.ok).toBe(true);
  });

  it('rejects oneOff with an invalid workspaceGroup', () => {
    const r = parsePromoteTarget({ oneOff: true, workspaceGroup: 'Has Space' });
    expect(r.ok).toBe(false);
  });

  it('rejects when neither project nor oneOff is set', () => {
    const r = parsePromoteTarget({});
    expect(r.ok).toBe(false);
  });

  it('rejects when both project and oneOff are set', () => {
    const r = parsePromoteTarget({ project: 'alpha', oneOff: true });
    expect(r.ok).toBe(false);
  });
});

describe('promoteTodosToNewAssignment (workspace scope, happy path)', () => {
  it('creates assignment with criteria and flips source todos to in_progress with linked id/ref', async () => {
    await seedProject('alpha');
    const items: TodoItem[] = [
      makeTodo('aaaa', 'first thing'),
      makeTodo('bbbb', 'second thing'),
    ];
    await writeChecklist(todosDir, {
      workspace: '_global',
      archiveInterval: 'weekly',
      items,
    });

    const result = await promoteTodosToNewAssignment(
      [{ todosDir, workspace: '_global', items, scopeLabel: '_global' }],
      {
        title: 'combined work',
        target: { project: 'alpha' },
      },
    );

    expect(result.assignmentRef).toMatch(/^alpha\//);
    expect(result.projectSlug).toBe('alpha');
    expect(result.promoted).toEqual([
      { workspace: '_global', id: 'aaaa' },
      { workspace: '_global', id: 'bbbb' },
    ]);

    // Source todos: in_progress + linkedAssignmentId + linkedAssignmentRef
    const checklist = await readChecklist(todosDir, '_global');
    for (const item of checklist.items) {
      expect(item.status).toBe('in_progress');
      expect(item.linkedAssignmentId).toBe(result.id);
      expect(item.linkedAssignmentRef).toBe(result.assignmentRef);
    }

    // assignment.md has criteria in caller order, no `## Todos` block
    const assignmentMd = await readFile(resolve(result.assignmentDir, 'assignment.md'), 'utf-8');
    expect(assignmentMd).toContain('- [ ] first thing');
    expect(assignmentMd).toContain('- [ ] second thing');
    expect(assignmentMd.indexOf('- [ ] first thing'))
      .toBeLessThan(assignmentMd.indexOf('- [ ] second thing'));
    expect(assignmentMd).not.toContain('## Todos');
  });

  it('keepSource leaves source items untouched', async () => {
    await seedProject('alpha');
    const items: TodoItem[] = [makeTodo('aaaa', 'leave me')];
    await writeChecklist(todosDir, {
      workspace: '_global',
      archiveInterval: 'weekly',
      items,
    });

    const result = await promoteTodosToNewAssignment(
      [{ todosDir, workspace: '_global', items, scopeLabel: '_global' }],
      {
        title: 'leave me alone',
        target: { project: 'alpha' },
        keepSource: true,
      },
    );

    expect(result.assignmentRef).toMatch(/^alpha\//);
    const checklist = await readChecklist(todosDir, '_global');
    // Untouched.
    expect(checklist.items[0].status).toBe('open');
    expect(checklist.items[0].linkedAssignmentId).toBeNull();
  });
});

describe('promoteTodosToNewAssignment (project scope, happy path)', () => {
  it('writes link metadata into the project todos checklist', async () => {
    await seedProject('beta');
    const projectTd = projectTodosDir(projectsDir, 'beta');
    await mkdir(projectTd, { recursive: true });

    const items: TodoItem[] = [makeTodo('cccc', 'project work item')];
    await writeChecklist(projectTd, {
      workspace: 'beta',
      archiveInterval: 'weekly',
      items,
    });

    const result = await promoteTodosToNewAssignment(
      [{ todosDir: projectTd, workspace: 'beta', items, scopeLabel: 'project:beta' }],
      {
        title: 'wrap it up',
        target: { project: 'beta' },
      },
    );

    expect(result.assignmentRef).toMatch(/^beta\//);
    const checklist = await readChecklist(projectTd, 'beta');
    expect(checklist.items[0].status).toBe('in_progress');
    expect(checklist.items[0].linkedAssignmentId).toBe(result.id);
    expect(checklist.items[0].linkedAssignmentRef).toBe(result.assignmentRef);
  });
});

describe('promoteTodosToNewAssignment (bulk / cross-workspace happy path)', () => {
  it('creates ONE assignment and links source todos across two workspaces in caller order', async () => {
    await seedProject('alpha');

    const itemsW1: TodoItem[] = [
      makeTodo('1111', 'w1-first'),
      makeTodo('2222', 'w1-second'),
    ];
    await writeChecklist(todosDir, {
      workspace: 'zeta', // alpha-sorted last on purpose
      archiveInterval: 'weekly',
      items: itemsW1,
    });
    const itemsW2: TodoItem[] = [makeTodo('3333', 'w2-only')];
    await writeChecklist(todosDir, {
      workspace: 'aardvark', // alpha-sorted first on purpose
      archiveInterval: 'weekly',
      items: itemsW2,
    });

    // Caller order is zeta first, aardvark second — criteria order MUST follow
    // caller order, not the alpha lock order.
    const result = await promoteTodosToNewAssignment(
      [
        { todosDir, workspace: 'zeta', items: itemsW1, scopeLabel: 'workspace:zeta' },
        { todosDir, workspace: 'aardvark', items: itemsW2, scopeLabel: 'workspace:aardvark' },
      ],
      {
        title: 'cross-ws',
        target: { project: 'alpha' },
      },
    );

    // Single assignment created.
    expect(result.promotedByWorkspace.map((g) => g.workspace).sort()).toEqual(['aardvark', 'zeta']);

    // Both checklists updated.
    const zeta = await readChecklist(todosDir, 'zeta');
    const aard = await readChecklist(todosDir, 'aardvark');
    for (const item of [...zeta.items, ...aard.items]) {
      expect(item.linkedAssignmentId).toBe(result.id);
      expect(item.linkedAssignmentRef).toBe(result.assignmentRef);
      expect(item.status).toBe('in_progress');
    }

    // Criteria order in assignment.md follows CALLER order (zeta first).
    const assignmentMd = await readFile(resolve(result.assignmentDir, 'assignment.md'), 'utf-8');
    const idxFirst = assignmentMd.indexOf('- [ ] w1-first');
    const idxSecond = assignmentMd.indexOf('- [ ] w1-second');
    const idxOnly = assignmentMd.indexOf('- [ ] w2-only');
    expect(idxFirst).toBeGreaterThan(-1);
    expect(idxFirst).toBeLessThan(idxSecond);
    expect(idxSecond).toBeLessThan(idxOnly);
  });
});

describe('promoteTodosToNewAssignment (one-off target)', () => {
  it('produces a bare-UUID assignmentRef when target is oneOff', async () => {
    const items: TodoItem[] = [makeTodo('dddd', 'standalone work')];
    await writeChecklist(todosDir, {
      workspace: '_global',
      archiveInterval: 'weekly',
      items,
    });

    const result = await promoteTodosToNewAssignment(
      [{ todosDir, workspace: '_global', items, scopeLabel: '_global' }],
      {
        title: 'standalone',
        target: { oneOff: true },
      },
    );

    expect(result.projectSlug).toBeNull();
    // Bare-UUID ref (no slash).
    expect(result.assignmentRef).not.toContain('/');
    expect(result.assignmentRef).toMatch(/^[0-9a-f]{8}-/);
    const checklist = await readChecklist(todosDir, '_global');
    expect(checklist.items[0].linkedAssignmentRef).toBe(result.assignmentRef);
  });
});
