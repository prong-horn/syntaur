import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { resolveAssignmentById } from '../utils/assignment-resolver.js';

let tmpRoot: string;
let projectsDir: string;
let assignmentsDir: string;

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), 'syntaur-resolver-test-'));
  projectsDir = resolve(tmpRoot, 'projects');
  assignmentsDir = resolve(tmpRoot, 'assignments');
  await mkdir(projectsDir, { recursive: true });
  await mkdir(assignmentsDir, { recursive: true });
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

async function writeAssignment(
  dir: string,
  id: string,
  extra: Record<string, string> = {},
): Promise<void> {
  await mkdir(dir, { recursive: true });
  const lines = [
    '---',
    `id: ${id}`,
    'slug: example',
    'title: Example',
    'status: pending',
    'priority: medium',
    'created: "2026-04-20T00:00:00Z"',
    'updated: "2026-04-20T00:00:00Z"',
    ...Object.entries(extra).map(([k, v]) => `${k}: ${v}`),
    '---',
    '',
    '# Example',
    '',
  ];
  await writeFile(resolve(dir, 'assignment.md'), lines.join('\n'));
}

describe('resolveAssignmentById', () => {
  it('finds a standalone assignment by its UUID folder name', async () => {
    const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const dir = resolve(assignmentsDir, id);
    await writeAssignment(dir, id, { project: 'null' });

    const resolved = await resolveAssignmentById(projectsDir, assignmentsDir, id);

    expect(resolved).not.toBeNull();
    expect(resolved!.standalone).toBe(true);
    expect(resolved!.projectSlug).toBeNull();
    expect(resolved!.assignmentSlug).toBe(id);
    expect(resolved!.assignmentDir).toBe(dir);
    expect(resolved!.id).toBe(id);
  });

  it('finds a project-nested assignment by scanning frontmatter ids', async () => {
    const id = '11111111-2222-3333-4444-555555555555';
    const projectSlug = 'my-project';
    const aslug = 'build-thing';
    const dir = resolve(projectsDir, projectSlug, 'assignments', aslug);
    await writeAssignment(dir, id, { slug: aslug, project: projectSlug });

    const resolved = await resolveAssignmentById(projectsDir, assignmentsDir, id);

    expect(resolved).not.toBeNull();
    expect(resolved!.standalone).toBe(false);
    expect(resolved!.projectSlug).toBe(projectSlug);
    expect(resolved!.assignmentSlug).toBe(aslug);
    expect(resolved!.assignmentDir).toBe(dir);
  });

  it('reads workspaceGroup from standalone frontmatter', async () => {
    const id = 'cccccccc-dddd-eeee-ffff-000000000000';
    const dir = resolve(assignmentsDir, id);
    await writeAssignment(dir, id, { project: 'null', workspaceGroup: 'syntaur' });

    const resolved = await resolveAssignmentById(projectsDir, assignmentsDir, id);

    expect(resolved).not.toBeNull();
    expect(resolved!.standalone).toBe(true);
    expect(resolved!.workspaceGroup).toBe('syntaur');
  });

  it('returns workspaceGroup as null for project-nested assignments', async () => {
    const id = 'dddddddd-eeee-ffff-0000-111111111111';
    const projectSlug = 'nested-proj';
    const aslug = 'nested-task';
    const dir = resolve(projectsDir, projectSlug, 'assignments', aslug);
    await writeAssignment(dir, id, { slug: aslug, project: projectSlug });

    const resolved = await resolveAssignmentById(projectsDir, assignmentsDir, id);

    expect(resolved).not.toBeNull();
    expect(resolved!.standalone).toBe(false);
    expect(resolved!.workspaceGroup).toBeNull();
  });

  it('returns null when the id is not found anywhere', async () => {
    const resolved = await resolveAssignmentById(
      projectsDir,
      assignmentsDir,
      'no-such-id-1234-5678-9012-345678901234',
    );
    expect(resolved).toBeNull();
  });

  it('prefers the standalone match when the same id appears in both locations', async () => {
    const id = '99999999-8888-7777-6666-555555555555';
    const standaloneDir = resolve(assignmentsDir, id);
    const projectNestedDir = resolve(projectsDir, 'proj', 'assignments', 'slug-form');
    await writeAssignment(standaloneDir, id, { project: 'null' });
    await writeAssignment(projectNestedDir, id, { slug: 'slug-form', project: 'proj' });

    const warn = console.warn;
    const warnings: string[] = [];
    console.warn = (msg: string) => warnings.push(msg);
    try {
      const resolved = await resolveAssignmentById(projectsDir, assignmentsDir, id);

      expect(resolved).not.toBeNull();
      expect(resolved!.standalone).toBe(true);
      expect(resolved!.assignmentDir).toBe(standaloneDir);
      expect(warnings.some((w) => w.includes('Duplicate assignment ID'))).toBe(true);
    } finally {
      console.warn = warn;
    }
  });
});
