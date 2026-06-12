import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { invalidateRecordsCache, resolveWorkspaceMembers } from '../dashboard/api.js';

let sandbox: string;
let projectsDir: string;
let assignmentsDir: string;

async function writeProject(slug: string, workspace: string | null): Promise<void> {
  const dir = resolve(projectsDir, slug);
  await mkdir(dir, { recursive: true });
  const ws = workspace === null ? '' : `\nworkspace: ${workspace}`;
  await writeFile(
    resolve(dir, 'project.md'),
    `---\nslug: ${slug}\ntitle: ${slug}\ncreated: "2026-05-01"\nupdated: "2026-05-01"${ws}\n---\n\n# ${slug}\n`,
    'utf-8',
  );
}

async function writeStandalone(id: string, workspaceGroup: string | null, archived = false): Promise<void> {
  const dir = resolve(assignmentsDir, id);
  await mkdir(dir, { recursive: true });
  const wg = workspaceGroup === null ? '' : `\nworkspaceGroup: ${workspaceGroup}`;
  await writeFile(
    resolve(dir, 'assignment.md'),
    `---\nid: ${id}\nslug: ${id}\ntitle: ${id}\nstatus: pending\npriority: medium\ncreated: "2026-05-01T00:00:00Z"\nupdated: "2026-05-01T00:00:00Z"\narchived: ${archived}${wg}\ntags: []\n---\n\n# ${id}\n`,
    'utf-8',
  );
}

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'syntaur-ws-members-'));
  projectsDir = resolve(sandbox, 'projects');
  assignmentsDir = resolve(sandbox, 'assignments');
  await mkdir(projectsDir, { recursive: true });
  await mkdir(assignmentsDir, { recursive: true });
  invalidateRecordsCache();
});

afterEach(async () => {
  invalidateRecordsCache();
  await rm(sandbox, { recursive: true, force: true });
});

describe('resolveWorkspaceMembers', () => {
  it('returns the named workspace members from both projects and standalones', async () => {
    await writeProject('p1', 'backend');
    await writeProject('p2', 'frontend');
    await writeStandalone('s1', 'backend');
    await writeStandalone('s2', 'frontend');

    const m = await resolveWorkspaceMembers(projectsDir, assignmentsDir, 'backend');
    expect(m.projectSlugs).toEqual(['p1']);
    expect(m.standaloneAssignmentIds).toEqual(['s1']);
  });

  it('_ungrouped selects null-workspace projects + null-group standalones', async () => {
    await writeProject('p1', 'backend');
    await writeProject('p2', null);
    await writeStandalone('s1', 'backend');
    await writeStandalone('s2', null);

    const m = await resolveWorkspaceMembers(projectsDir, assignmentsDir, '_ungrouped');
    expect(m.projectSlugs).toEqual(['p2']);
    expect(m.standaloneAssignmentIds).toEqual(['s2']);
  });

  it('excludes archived standalones', async () => {
    await writeStandalone('live', 'backend');
    await writeStandalone('dead', 'backend', true);

    const m = await resolveWorkspaceMembers(projectsDir, assignmentsDir, 'backend');
    expect(m.standaloneAssignmentIds).toEqual(['live']);
  });

  it('returns empty arrays for an unknown workspace', async () => {
    await writeProject('p1', 'backend');
    const m = await resolveWorkspaceMembers(projectsDir, assignmentsDir, 'nope');
    expect(m).toEqual({ projectSlugs: [], standaloneAssignmentIds: [] });
  });
});
