import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { resolveAssignmentBySlug } from '../utils/assignment-resolver.js';

let sandbox: string;
let projectsDir: string;
let assignmentsDir: string;

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'syntaur-resolver-'));
  projectsDir = resolve(sandbox, 'projects');
  assignmentsDir = resolve(sandbox, 'assignments');
});

afterEach(async () => {
  await rm(sandbox, { recursive: true, force: true });
});

async function writeProjectAssignment(
  projectSlug: string,
  assignmentSlug: string,
  frontmatter: string,
): Promise<void> {
  const dir = resolve(projectsDir, projectSlug, 'assignments', assignmentSlug);
  await mkdir(dir, { recursive: true });
  await writeFile(resolve(dir, 'assignment.md'), `---\n${frontmatter}\n---\n\n# ${assignmentSlug}\n`, 'utf-8');
}

async function writeStandaloneAssignment(slug: string, frontmatter: string): Promise<void> {
  const dir = resolve(assignmentsDir, slug);
  await mkdir(dir, { recursive: true });
  await writeFile(resolve(dir, 'assignment.md'), `---\n${frontmatter}\n---\n\n# ${slug}\n`, 'utf-8');
}

describe('resolveAssignmentBySlug', () => {
  it('returns {exists:true, id} for a project-nested assignment', async () => {
    await writeProjectAssignment('proj', 'asgn', 'id: abc-123\nslug: asgn\ntitle: Asgn');
    const r = await resolveAssignmentBySlug(projectsDir, assignmentsDir, 'proj', 'asgn');
    expect(r).toEqual({ exists: true, id: 'abc-123' });
  });

  it('returns {exists:true, id} for a standalone assignment', async () => {
    await writeStandaloneAssignment('solo', 'id: solo-uuid\nslug: solo\ntitle: Solo');
    const r = await resolveAssignmentBySlug(projectsDir, assignmentsDir, null, 'solo');
    expect(r).toEqual({ exists: true, id: 'solo-uuid' });
  });

  it('returns {exists:true, id:null} for an existing but idless assignment', async () => {
    await writeProjectAssignment('proj', 'noid', 'slug: noid\ntitle: NoId');
    const r = await resolveAssignmentBySlug(projectsDir, assignmentsDir, 'proj', 'noid');
    expect(r).toEqual({ exists: true, id: null });
  });

  it('returns {exists:false, id:null} for a missing assignment', async () => {
    const r = await resolveAssignmentBySlug(projectsDir, assignmentsDir, 'proj', 'ghost');
    expect(r).toEqual({ exists: false, id: null });
  });

  it('does not throw on a missing standalone assignment', async () => {
    const r = await resolveAssignmentBySlug(projectsDir, assignmentsDir, null, 'ghost');
    expect(r).toEqual({ exists: false, id: null });
  });
});
