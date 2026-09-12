import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { listTicketsByProject } from '../utils/ticket-walk.js';

let root: string;
let projectsDir: string;
let standaloneDir: string;

async function seedAssignment(dir: string, status = 'pending'): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'ticket.md'),
    `---\nslug: test\ntitle: t\nstatus: ${status}\n---\n# t\n`,
  );
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'syntaur-ticket-walk-'));
  projectsDir = join(root, 'projects');
  standaloneDir = join(root, 'standalone');
  await mkdir(projectsDir, { recursive: true });
  await mkdir(standaloneDir, { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('listTicketsByProject', () => {
  it('walks project + standalone trees and groups with vs without ticket.md', async () => {
    await seedAssignment(join(projectsDir, 'p1', 'tickets', 'a1'));
    await seedAssignment(join(projectsDir, 'p1', 'tickets', 'a2'));
    await seedAssignment(join(projectsDir, 'p2', 'tickets', 'b1'));
    await seedAssignment(join(standaloneDir, 'uuid-1'));
    // Folder with no ticket.md → orphan
    await mkdir(join(projectsDir, 'p1', 'tickets', 'orphan-x'), { recursive: true });
    await mkdir(join(standaloneDir, 'orphan-y'), { recursive: true });

    const result = await listTicketsByProject(projectsDir, standaloneDir);

    expect(result.withAssignmentMd).toHaveLength(4);
    expect(result.orphanFolders).toHaveLength(2);

    const slugs = result.withAssignmentMd.map((e) => e.ticketSlug).sort();
    expect(slugs).toEqual(['a1', 'a2', 'b1', 'uuid-1']);

    const standaloneEntry = result.withAssignmentMd.find((e) => e.ticketSlug === 'uuid-1');
    expect(standaloneEntry?.standalone).toBe(true);
    expect(standaloneEntry?.projectSlug).toBeNull();

    const projectEntry = result.withAssignmentMd.find((e) => e.ticketSlug === 'a1');
    expect(projectEntry?.projectSlug).toBe('p1');
    expect(projectEntry?.standalone).toBe(false);
  });

  it('skips dot-prefixed and underscore-prefixed directories at every level', async () => {
    await seedAssignment(join(projectsDir, 'p1', 'tickets', 'visible'));
    await seedAssignment(join(projectsDir, 'p1', 'tickets', '.hidden'));
    await seedAssignment(join(projectsDir, 'p1', 'tickets', '_underscore'));
    await seedAssignment(join(projectsDir, '.hidden-project', 'tickets', 'a'));
    await seedAssignment(join(projectsDir, '_idx', 'tickets', 'a'));
    await seedAssignment(join(standaloneDir, '.hidden-uuid'));
    await seedAssignment(join(standaloneDir, '_meta'));
    await seedAssignment(join(standaloneDir, 'real-uuid'));

    const result = await listTicketsByProject(projectsDir, standaloneDir);

    const slugs = result.withAssignmentMd.map((e) => e.ticketSlug).sort();
    expect(slugs).toEqual(['real-uuid', 'visible']);
  });

  it('treats standaloneDir=null as skip-standalone (matches non-standalone-mode dashboards)', async () => {
    await seedAssignment(join(projectsDir, 'p1', 'tickets', 'a1'));
    await seedAssignment(join(standaloneDir, 'uuid-1'));

    const result = await listTicketsByProject(projectsDir, null);

    expect(result.withAssignmentMd).toHaveLength(1);
    expect(result.withAssignmentMd[0].ticketSlug).toBe('a1');
  });

  it('returns empty result when projectsDir does not exist', async () => {
    const result = await listTicketsByProject(join(root, 'nonexistent'), null);
    expect(result.withAssignmentMd).toHaveLength(0);
    expect(result.orphanFolders).toHaveLength(0);
  });
});
