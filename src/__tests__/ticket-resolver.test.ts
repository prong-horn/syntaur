import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import {
  resolveTicketById,
  resolveTicketSlugInProject,
  TicketResolverError,
} from '../utils/ticket-resolver.js';

let sandbox: string;
let projectsDir: string;

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'syntaur-resolver-'));
  projectsDir = resolve(sandbox, 'projects');
});

afterEach(async () => {
  await rm(sandbox, { recursive: true, force: true });
});

async function writeProjectTicket(
  projectSlug: string,
  folderName: string,
  frontmatter: string,
): Promise<void> {
  const dir = resolve(projectsDir, projectSlug, 'tickets', folderName);
  await mkdir(dir, { recursive: true });
  await writeFile(resolve(dir, 'ticket.md'), `---\n${frontmatter}\n---\n\n# ticket\n`, 'utf-8');
}

describe('resolveTicketById', () => {
  it('resolves by id through the <ID>-<slug> folder name', async () => {
    await writeProjectTicket(
      'proj',
      'FIT-1-my-ticket',
      'id: FIT-1\nslug: my-ticket\ntitle: My Ticket',
    );
    const r = await resolveTicketById(projectsDir, 'FIT-1');
    expect(r).toMatchObject({
      projectSlug: 'proj',
      ticketSlug: 'my-ticket',
      id: 'FIT-1',
      standalone: false,
    });
  });

  it('returns null when no folder matches the id prefix', async () => {
    const r = await resolveTicketById(projectsDir, 'FIT-9');
    expect(r).toBeNull();
  });

  it('throws when multiple folders match the same id', async () => {
    await writeProjectTicket('proj', 'FIT-1-a', 'id: FIT-1\nslug: a\ntitle: A');
    await writeProjectTicket('proj', 'FIT-1-b', 'id: FIT-1\nslug: b\ntitle: B');
    await expect(resolveTicketById(projectsDir, 'FIT-1')).rejects.toBeInstanceOf(
      TicketResolverError,
    );
  });
});

describe('resolveTicketSlugInProject', () => {
  it('finds a ticket by display slug within a project', async () => {
    await writeProjectTicket(
      'proj',
      'SCR-2-alpha',
      'id: SCR-2\nslug: alpha\ntitle: Alpha',
    );
    const r = await resolveTicketSlugInProject(projectsDir, 'proj', 'alpha');
    expect(r?.id).toBe('SCR-2');
  });
});
