import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { resolveTicketBySlug } from '../utils/ticket-resolver.js';

let sandbox: string;
let projectsDir: string;
let ticketsDir: string;

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'syntaur-resolver-'));
  projectsDir = resolve(sandbox, 'projects');
  ticketsDir = resolve(sandbox, 'tickets');
});

afterEach(async () => {
  await rm(sandbox, { recursive: true, force: true });
});

async function writeProjectAssignment(
  projectSlug: string,
  ticketSlug: string,
  frontmatter: string,
): Promise<void> {
  const dir = resolve(projectsDir, projectSlug, 'tickets', ticketSlug);
  await mkdir(dir, { recursive: true });
  await writeFile(resolve(dir, 'ticket.md'), `---\n${frontmatter}\n---\n\n# ${ticketSlug}\n`, 'utf-8');
}

async function writeStandaloneAssignment(slug: string, frontmatter: string): Promise<void> {
  const dir = resolve(ticketsDir, slug);
  await mkdir(dir, { recursive: true });
  await writeFile(resolve(dir, 'ticket.md'), `---\n${frontmatter}\n---\n\n# ${slug}\n`, 'utf-8');
}

describe('resolveTicketBySlug', () => {
  it('returns {exists:true, id} for a project-nested ticket', async () => {
    await writeProjectAssignment('proj', 'asgn', 'id: abc-123\nslug: asgn\ntitle: Asgn');
    const r = await resolveTicketBySlug(projectsDir, ticketsDir, 'proj', 'asgn');
    expect(r).toEqual({ exists: true, id: 'abc-123' });
  });

  it('returns {exists:true, id} for a standalone ticket', async () => {
    await writeStandaloneAssignment('solo', 'id: solo-uuid\nslug: solo\ntitle: Solo');
    const r = await resolveTicketBySlug(projectsDir, ticketsDir, null, 'solo');
    expect(r).toEqual({ exists: true, id: 'solo-uuid' });
  });

  it('returns {exists:true, id:null} for an existing but idless assignment', async () => {
    await writeProjectAssignment('proj', 'noid', 'slug: noid\ntitle: NoId');
    const r = await resolveTicketBySlug(projectsDir, ticketsDir, 'proj', 'noid');
    expect(r).toEqual({ exists: true, id: null });
  });

  it('returns {exists:false, id:null} for a missing assignment', async () => {
    const r = await resolveTicketBySlug(projectsDir, ticketsDir, 'proj', 'ghost');
    expect(r).toEqual({ exists: false, id: null });
  });

  it('does not throw on a missing standalone ticket', async () => {
    const r = await resolveTicketBySlug(projectsDir, ticketsDir, null, 'ghost');
    expect(r).toEqual({ exists: false, id: null });
  });
});
