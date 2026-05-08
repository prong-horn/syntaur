import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { resolveAssignmentTarget, AssignmentTargetError } from '../utils/assignment-target.js';

let originalHome: string | undefined;
let tmpRoot: string;
let projectsDir: string;
let assignmentsDir: string;
let cwdRoot: string;

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), 'syntaur-assignment-target-'));
  projectsDir = resolve(tmpRoot, 'projects');
  assignmentsDir = resolve(tmpRoot, 'assignments');
  cwdRoot = resolve(tmpRoot, 'cwd');
  await mkdir(projectsDir, { recursive: true });
  await mkdir(assignmentsDir, { recursive: true });
  await mkdir(cwdRoot, { recursive: true });

  originalHome = process.env.SYNTAUR_HOME;
  process.env.SYNTAUR_HOME = tmpRoot;
});

afterEach(async () => {
  if (originalHome === undefined) delete process.env.SYNTAUR_HOME;
  else process.env.SYNTAUR_HOME = originalHome;
  await rm(tmpRoot, { recursive: true, force: true });
});

async function writeProject(slug: string): Promise<void> {
  const dir = resolve(projectsDir, slug);
  await mkdir(dir, { recursive: true });
  await writeFile(
    resolve(dir, 'project.md'),
    [
      '---',
      `id: proj-${slug}`,
      `slug: ${slug}`,
      `title: ${slug}`,
      '---',
      '',
      `# ${slug}`,
      '',
    ].join('\n'),
  );
}

async function writeAssignment(
  dir: string,
  id: string,
  extras: Record<string, string> = {},
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
    ...Object.entries(extras).map(([k, v]) => `${k}: ${v}`),
    '---',
    '',
    '# Example',
    '',
  ];
  await writeFile(resolve(dir, 'assignment.md'), lines.join('\n'));
}

async function writeContextJson(cwd: string, payload: Record<string, unknown>): Promise<void> {
  const dir = resolve(cwd, '.syntaur');
  await mkdir(dir, { recursive: true });
  await writeFile(resolve(dir, 'context.json'), JSON.stringify(payload, null, 2));
}

describe('resolveAssignmentTarget', () => {
  it('resolves --project + assignment slug', async () => {
    const projectSlug = 'my-proj';
    const aslug = 'do-thing';
    const id = '11111111-2222-3333-4444-555555555555';
    await writeProject(projectSlug);
    await writeAssignment(resolve(projectsDir, projectSlug, 'assignments', aslug), id, {
      slug: aslug,
      project: projectSlug,
    });

    const resolved = await resolveAssignmentTarget(aslug, { project: projectSlug, dir: tmpRoot + '/projects' });

    expect(resolved.projectSlug).toBe(projectSlug);
    expect(resolved.assignmentSlug).toBe(aslug);
    expect(resolved.standalone).toBe(false);
    expect(resolved.id).toBe(id);
  });

  it('resolves a bare standalone UUID', async () => {
    const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    await writeAssignment(resolve(assignmentsDir, id), id, { project: 'null' });

    const resolved = await resolveAssignmentTarget(id, { dir: projectsDir });

    expect(resolved.standalone).toBe(true);
    expect(resolved.assignmentSlug).toBe(id);
    expect(resolved.id).toBe(id);
  });

  it('resolves a project-nested UUID via frontmatter id scan', async () => {
    const id = '99999999-aaaa-bbbb-cccc-dddddddddddd';
    const projectSlug = 'scan-proj';
    const aslug = 'scan-task';
    await writeProject(projectSlug);
    await writeAssignment(resolve(projectsDir, projectSlug, 'assignments', aslug), id, {
      slug: aslug,
      project: projectSlug,
    });

    const resolved = await resolveAssignmentTarget(id, { dir: projectsDir });

    expect(resolved.projectSlug).toBe(projectSlug);
    expect(resolved.assignmentSlug).toBe(aslug);
    expect(resolved.standalone).toBe(false);
  });

  it('falls back to .syntaur/context.json (assignmentDir form)', async () => {
    const id = 'cccccccc-dddd-eeee-ffff-000000000000';
    const dir = resolve(assignmentsDir, id);
    await writeAssignment(dir, id, { project: 'null' });
    await writeContextJson(cwdRoot, { assignmentDir: dir });

    const resolved = await resolveAssignmentTarget(undefined, { cwd: cwdRoot, dir: projectsDir });

    expect(resolved.assignmentDir).toBe(dir);
    expect(resolved.id).toBe(id);
    expect(resolved.standalone).toBe(true);
  });

  it('falls back to .syntaur/context.json (projectSlug+assignmentSlug form)', async () => {
    const projectSlug = 'ctx-proj';
    const aslug = 'ctx-task';
    const id = '22222222-3333-4444-5555-666666666666';
    await writeProject(projectSlug);
    await writeAssignment(resolve(projectsDir, projectSlug, 'assignments', aslug), id, {
      slug: aslug,
      project: projectSlug,
    });
    await writeContextJson(cwdRoot, { projectSlug, assignmentSlug: aslug });

    const resolved = await resolveAssignmentTarget(undefined, { cwd: cwdRoot, dir: projectsDir });

    expect(resolved.projectSlug).toBe(projectSlug);
    expect(resolved.assignmentSlug).toBe(aslug);
    expect(resolved.id).toBe(id);
  });

  it('throws when no input and no context.json', async () => {
    await expect(resolveAssignmentTarget(undefined, { cwd: cwdRoot, dir: projectsDir })).rejects.toThrow(
      AssignmentTargetError,
    );
  });

  it('throws on invalid project slug', async () => {
    await expect(
      resolveAssignmentTarget('foo', { project: 'BAD slug!', dir: projectsDir }),
    ).rejects.toThrow(/Invalid project slug/);
  });

  it('throws when --project is given without a positional slug', async () => {
    await expect(
      resolveAssignmentTarget(undefined, { project: 'some-proj', dir: projectsDir }),
    ).rejects.toThrow(/--project requires/);
  });

  it('throws on missing project', async () => {
    await expect(
      resolveAssignmentTarget('some-task', { project: 'no-such-project', dir: projectsDir }),
    ).rejects.toThrow(/not found/);
  });

  it('throws on unknown bare UUID', async () => {
    await expect(
      resolveAssignmentTarget('not-a-real-id-xxxx', { dir: projectsDir }),
    ).rejects.toThrow(/not found/);
  });

  it('throws when context.json points to a missing dir', async () => {
    await writeContextJson(cwdRoot, { assignmentDir: resolve(tmpRoot, 'nope') });

    await expect(
      resolveAssignmentTarget(undefined, { cwd: cwdRoot, dir: projectsDir }),
    ).rejects.toThrow(/missing assignment dir/);
  });

  it('throws when context.json points to an assignment with no frontmatter id', async () => {
    const idlessDir = resolve(assignmentsDir, 'no-id-folder');
    await mkdir(idlessDir, { recursive: true });
    // Write an assignment.md with no `id:` frontmatter field.
    await writeFile(
      resolve(idlessDir, 'assignment.md'),
      ['---', 'slug: example', 'title: Example', '---', '', '# Example', ''].join('\n'),
    );
    await writeContextJson(cwdRoot, { assignmentDir: idlessDir });

    await expect(
      resolveAssignmentTarget(undefined, { cwd: cwdRoot, dir: projectsDir }),
    ).rejects.toThrow(/no frontmatter `id`/);
  });

  it('throws when context.json has neither shape', async () => {
    await writeContextJson(cwdRoot, { sessionId: 'abc' });

    await expect(
      resolveAssignmentTarget(undefined, { cwd: cwdRoot, dir: projectsDir }),
    ).rejects.toThrow(/neither assignmentDir nor projectSlug/);
  });
});
