import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import {
  resolveTicketById,
  TicketResolverError,
} from '../utils/ticket-resolver.js';

let tmpRoot: string;
let projectsDir: string;

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), 'syntaur-resolver-test-'));
  projectsDir = resolve(tmpRoot, 'projects');
  await mkdir(projectsDir, { recursive: true });
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

async function writeProjectTicket(
  projectSlug: string,
  folderName: string,
  frontmatter: string,
): Promise<void> {
  const dir = resolve(projectsDir, projectSlug, 'tickets', folderName);
  await mkdir(dir, { recursive: true });
  await writeFile(resolve(dir, 'ticket.md'), `---\n${frontmatter}\n---\n\n# Example\n`, 'utf-8');
}

describe('resolveTicketById', () => {
  it('finds a project-nested ticket by id via <ID>-<slug> folder name', async () => {
    await writeProjectTicket(
      'my-project',
      'FIT-1-build-thing',
      'id: FIT-1\nslug: build-thing\ntitle: Build Thing',
    );

    const resolved = await resolveTicketById(projectsDir, 'FIT-1');

    expect(resolved).not.toBeNull();
    expect(resolved!.standalone).toBe(false);
    expect(resolved!.projectSlug).toBe('my-project');
    expect(resolved!.ticketSlug).toBe('build-thing');
    expect(resolved!.id).toBe('FIT-1');
  });

  it('returns null for non-ticket-id strings', async () => {
    const resolved = await resolveTicketById(projectsDir, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    );
    expect(resolved).toBeNull();
  });

  it('returns null when the id is not found anywhere', async () => {
    const resolved = await resolveTicketById(projectsDir, 'FIT-99');
    expect(resolved).toBeNull();
  });

  it('throws when multiple folders match the same id', async () => {
    await writeProjectTicket('proj', 'SCR-1-a', 'id: SCR-1\nslug: a\ntitle: A');
    await writeProjectTicket('proj', 'SCR-1-b', 'id: SCR-1\nslug: b\ntitle: B');

    await expect(resolveTicketById(projectsDir, 'SCR-1')).rejects.toBeInstanceOf(
      TicketResolverError,
    );
  });
});
