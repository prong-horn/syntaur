import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { listTicketsByProject } from '../utils/ticket-walk.js';

let root: string;
let projectsDir: string;

async function seedTicket(dir: string, status = 'pending'): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'ticket.md'),
    `---\nslug: test\ntitle: t\nstatus: ${status}\n---\n# t\n`,
  );
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'syntaur-ticket-walk-'));
  projectsDir = join(root, 'projects');
  await mkdir(projectsDir, { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('listTicketsByProject', () => {
  it('walks project tickets with <ID>-<slug> folders', async () => {
    await seedTicket(join(projectsDir, 'p1', 'tickets', 'FIT-1-alpha'));
    await seedTicket(join(projectsDir, 'p1', 'tickets', 'FIT-2-beta'));
    await seedTicket(join(projectsDir, 'p2', 'tickets', 'SCR-1-gamma'));
    await mkdir(join(projectsDir, 'p1', 'tickets', 'orphan-x'), { recursive: true });

    const result = await listTicketsByProject(projectsDir, null);

    expect(result.withTicketMd).toHaveLength(3);
    expect(result.orphanFolders).toHaveLength(1);
    expect(result.withTicketMd.map((e) => e.ticketId).sort()).toEqual(['FIT-1', 'FIT-2', 'SCR-1']);
    expect(result.withTicketMd.every((e) => e.standalone === false)).toBe(true);
  });

  it('skips dot-prefixed and underscore-prefixed directories at every level', async () => {
    await seedTicket(join(projectsDir, 'p1', 'tickets', 'TP-1-visible'));
    await seedTicket(join(projectsDir, 'p1', 'tickets', '.hidden'));
    await seedTicket(join(projectsDir, 'p1', 'tickets', '_underscore'));

    const result = await listTicketsByProject(projectsDir, null);
    expect(result.withTicketMd.map((e) => e.ticketId)).toEqual(['TP-1']);
  });
});
