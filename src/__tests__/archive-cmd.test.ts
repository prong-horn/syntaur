import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runArchive, runRestore } from '../commands/_archive-helper.js';
import { parseAssignmentFrontmatter } from '../lifecycle/frontmatter.js';

let home: string;
let projectsDir: string;
let prevHome: string | undefined;

function assignmentMd(id: string, slug: string, status: string): string {
  return `---\nid: ${id}\nslug: ${slug}\ntitle: "${slug}"\nproject: p\nstatus: ${status}\npriority: medium\ncreated: "2026-04-01T00:00:00Z"\nupdated: "2026-04-01T00:00:00Z"\nassignee: null\nexternalIds: []\ndependsOn: []\nblockedReason: null\nworkspace:\n  repository: null\n  worktreePath: null\n  branch: null\n  parentBranch: null\ntags: []\n---\n\nBody.\n`;
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'syntaur-archive-cmd-'));
  prevHome = process.env.SYNTAUR_HOME;
  process.env.SYNTAUR_HOME = home;
  projectsDir = resolve(home, 'projects');

  // Project 'p' with a project-scoped assignment 'a1'.
  const pDir = resolve(projectsDir, 'p');
  await mkdir(resolve(pDir, 'assignments', 'a1'), { recursive: true });
  await writeFile(resolve(pDir, 'project.md'), '---\nid: pid\nslug: p\ntitle: "P"\narchived: false\narchivedAt: null\narchivedReason: null\n---\n');
  await writeFile(resolve(pDir, 'assignments', 'a1', 'assignment.md'), assignmentMd('a1id', 'a1', 'in_progress'));

  // Standalone assignment resolvable by UUID.
  const sDir = resolve(home, 'assignments', 'standalone-uuid');
  await mkdir(sDir, { recursive: true });
  await writeFile(resolve(sDir, 'assignment.md'), assignmentMd('standalone-uuid', 'solo', 'review').replace('project: p\n', ''));
});

afterEach(async () => {
  if (prevHome === undefined) delete process.env.SYNTAUR_HOME;
  else process.env.SYNTAUR_HOME = prevHome;
  await rm(home, { recursive: true, force: true });
});

describe('runArchive / runRestore', () => {
  it('archives + restores a project-scoped assignment, preserving status', async () => {
    const path = resolve(projectsDir, 'p', 'assignments', 'a1', 'assignment.md');

    const archived = await runArchive('a1', { project: 'p', dir: projectsDir, reason: 'stale' });
    expect(archived.success).toBe(true);
    let fm = parseAssignmentFrontmatter(await readFile(path, 'utf-8'));
    expect(fm.archived).toBe(true);
    expect(fm.archivedReason).toBe('stale');
    expect(fm.status).toBe('in_progress'); // status untouched

    const restored = await runRestore('a1', { project: 'p', dir: projectsDir });
    expect(restored.success).toBe(true);
    fm = parseAssignmentFrontmatter(await readFile(path, 'utf-8'));
    expect(fm.archived).toBe(false);
    expect(fm.archivedAt).toBeNull();
    expect(fm.status).toBe('in_progress'); // prior status preserved
  });

  it('archives a standalone assignment resolved by UUID', async () => {
    const path = resolve(home, 'assignments', 'standalone-uuid', 'assignment.md');
    const res = await runArchive('standalone-uuid', { dir: projectsDir });
    expect(res.success).toBe(true);
    const fm = parseAssignmentFrontmatter(await readFile(path, 'utf-8'));
    expect(fm.archived).toBe(true);
    expect(fm.status).toBe('review');
  });

  it('archives + restores a project by slug', async () => {
    const path = resolve(projectsDir, 'p', 'project.md');
    const archived = await runArchive('p', { dir: projectsDir });
    expect(archived.success).toBe(true);
    expect(await readFile(path, 'utf-8')).toContain('archived: true');

    const restored = await runRestore('p', { dir: projectsDir });
    expect(restored.success).toBe(true);
    expect(await readFile(path, 'utf-8')).toContain('archived: false');
  });

  it('returns a failure result when nothing matches', async () => {
    const res = await runArchive('does-not-exist', { dir: projectsDir });
    expect(res.success).toBe(false);
    expect(res.message).toMatch(/No assignment or project matched/);
  });
});
