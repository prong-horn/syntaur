import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { resolveTicketById } from '../utils/ticket-resolver.js';

let tmpRoot: string;
let projectsDir: string;
let ticketsDir: string;

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), 'syntaur-resolver-test-'));
  projectsDir = resolve(tmpRoot, 'projects');
  ticketsDir = resolve(tmpRoot, 'tickets');
  await mkdir(projectsDir, { recursive: true });
  await mkdir(ticketsDir, { recursive: true });
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

async function writeTicket(
  dir: string,
  id: string,
  extra: Record<string, string> = {},
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
    ...Object.entries(extra).map(([k, v]) => `${k}: ${v}`),
    '---',
    '',
    '# Example',
    '',
  ];
  await writeFile(resolve(dir, 'ticket.md'), lines.join('\n'));
}

describe('resolveTicketById', () => {
  it('finds a standalone ticket by its UUID folder name', async () => {
    const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const dir = resolve(ticketsDir, id);
    await writeTicket(dir, id, { project: 'null' });

    const resolved = await resolveTicketById(projectsDir, ticketsDir, id);

    expect(resolved).not.toBeNull();
    expect(resolved!.standalone).toBe(true);
    expect(resolved!.projectSlug).toBeNull();
    expect(resolved!.ticketSlug).toBe(id);
    expect(resolved!.ticketDir).toBe(dir);
    expect(resolved!.id).toBe(id);
  });

  it('finds a project-nested ticket by scanning frontmatter ids', async () => {
    const id = '11111111-2222-3333-4444-555555555555';
    const projectSlug = 'my-project';
    const aslug = 'build-thing';
    const dir = resolve(projectsDir, projectSlug, 'tickets', aslug);
    await writeTicket(dir, id, { slug: aslug, project: projectSlug });

    const resolved = await resolveTicketById(projectsDir, ticketsDir, id);

    expect(resolved).not.toBeNull();
    expect(resolved!.standalone).toBe(false);
    expect(resolved!.projectSlug).toBe(projectSlug);
    expect(resolved!.ticketSlug).toBe(aslug);
    expect(resolved!.ticketDir).toBe(dir);
  });

  it('returns null when the id is not found anywhere', async () => {
    const resolved = await resolveTicketById(
      projectsDir,
      ticketsDir,
      'no-such-id-1234-5678-9012-345678901234',
    );
    expect(resolved).toBeNull();
  });

  it('prefers the standalone match when the same id appears in both locations', async () => {
    const id = '99999999-8888-7777-6666-555555555555';
    const standaloneDir = resolve(ticketsDir, id);
    const projectNestedDir = resolve(projectsDir, 'proj', 'tickets', 'slug-form');
    await writeTicket(standaloneDir, id, { project: 'null' });
    await writeTicket(projectNestedDir, id, { slug: 'slug-form', project: 'proj' });

    const warn = console.warn;
    const warnings: string[] = [];
    console.warn = (msg: string) => warnings.push(msg);
    try {
      const resolved = await resolveTicketById(projectsDir, ticketsDir, id);

      expect(resolved).not.toBeNull();
      expect(resolved!.standalone).toBe(true);
      expect(resolved!.ticketDir).toBe(standaloneDir);
      expect(warnings.some((w) => w.includes('Duplicate ticket ID'))).toBe(true);
    } finally {
      console.warn = warn;
    }
  });
});
