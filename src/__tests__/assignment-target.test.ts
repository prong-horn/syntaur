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

  it('resolves from the open engagement (project-nested)', async () => {
    const projectSlug = 'eng-proj';
    const aslug = 'eng-task';
    const id = '33333333-4444-5555-6666-777777777777';
    await writeProject(projectSlug);
    await writeAssignment(resolve(projectsDir, projectSlug, 'assignments', aslug), id, {
      slug: aslug,
      project: projectSlug,
    });

    const resolved = await resolveAssignmentTarget(undefined, {
      cwd: cwdRoot,
      dir: projectsDir,
      resolveEngagement: async () => ({
        assignmentId: id,
        projectSlug,
        assignmentSlug: aslug,
        stage: 'plan',
      }),
    });

    expect(resolved.projectSlug).toBe(projectSlug);
    expect(resolved.assignmentSlug).toBe(aslug);
    expect(resolved.standalone).toBe(false);
    expect(resolved.id).toBe(id);
    expect(resolved.stage).toBe('plan');
  });

  it('resolves from the open engagement (standalone, by id)', async () => {
    const id = 'dddddddd-eeee-ffff-0000-111111111111';
    await writeAssignment(resolve(assignmentsDir, id), id, { project: 'null' });

    const resolved = await resolveAssignmentTarget(undefined, {
      cwd: cwdRoot,
      dir: projectsDir,
      resolveEngagement: async () => ({
        assignmentId: id,
        projectSlug: null,
        assignmentSlug: id,
        stage: 'implement',
      }),
    });

    expect(resolved.standalone).toBe(true);
    expect(resolved.assignmentSlug).toBe(id);
    expect(resolved.id).toBe(id);
    expect(resolved.stage).toBe('implement');
  });

  it('explicit --project + slug takes precedence over the open engagement (seam not consulted)', async () => {
    const projectSlug = 'explicit-proj';
    const aslug = 'explicit-task';
    const id = '44444444-5555-6666-7777-888888888888';
    await writeProject(projectSlug);
    await writeAssignment(resolve(projectsDir, projectSlug, 'assignments', aslug), id, {
      slug: aslug,
      project: projectSlug,
    });

    let called = false;
    const resolved = await resolveAssignmentTarget(aslug, {
      project: projectSlug,
      dir: projectsDir,
      resolveEngagement: async () => {
        called = true;
        return { assignmentId: 'x', projectSlug: 'other', assignmentSlug: 'other', stage: 'plan' };
      },
    });

    expect(resolved.assignmentSlug).toBe(aslug);
    expect(called).toBe(false);
  });

  it('throws the selector error when there is no positional and no open engagement', async () => {
    await expect(
      resolveAssignmentTarget(undefined, {
        cwd: cwdRoot,
        dir: projectsDir,
        resolveEngagement: async () => null,
      }),
    ).rejects.toThrow(/No open engagement/);
  });

  it('throws when no resolveEngagement seam is provided', async () => {
    await expect(
      resolveAssignmentTarget(undefined, { cwd: cwdRoot, dir: projectsDir }),
    ).rejects.toThrow(AssignmentTargetError);
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

  it('throws when the open engagement points to a missing assignment', async () => {
    await expect(
      resolveAssignmentTarget(undefined, {
        cwd: cwdRoot,
        dir: projectsDir,
        resolveEngagement: async () => ({
          assignmentId: 'x',
          projectSlug: 'ghost-proj',
          assignmentSlug: 'ghost-task',
          stage: 'plan',
        }),
      }),
    ).rejects.toThrow(/missing assignment/);
  });

  it('surfaces a bundle-context error instead of resolving an assignment', async () => {
    await writeContextJson(cwdRoot, { bundleId: 'b123', bundleSlug: 'my-bundle' });

    await expect(
      resolveAssignmentTarget(undefined, {
        cwd: cwdRoot,
        dir: projectsDir,
        resolveEngagement: async () => null,
      }),
    ).rejects.toThrow(/bound to bundle/);
  });

  it('does not let a workspace-marker-only context.json resolve an assignment', async () => {
    // context.json with only workspace markers (the demoted shape) must NOT
    // resolve a target — only the open engagement can.
    await writeContextJson(cwdRoot, {
      repository: '/repo',
      branch: 'feat/x',
      worktreePath: '/repo/.worktrees/x',
      sessionId: 'sess-abc',
    });

    await expect(
      resolveAssignmentTarget(undefined, {
        cwd: cwdRoot,
        dir: projectsDir,
        resolveEngagement: async () => null,
      }),
    ).rejects.toThrow(/No open engagement/);
  });
});
