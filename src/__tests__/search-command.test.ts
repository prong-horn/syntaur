import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runSearch } from '../commands/search.js';

let testDir: string;
let origSyntaurHome: string | undefined;

/**
 * Seed a SYNTAUR_HOME with one project (workspace `acme-ws`) containing one
 * ticket (ticket.md + comments.md), plus a standalone ticket.
 * Each file body carries the searchable term "widget".
 */
async function seedHome(root: string): Promise<void> {
  const projectsDir = join(root, 'projects');
  const ticketsDir = join(root, 'tickets');

  await mkdir(root, { recursive: true });
  await writeFile(
    join(root, 'config.md'),
    `---\nversion: "2.0"\ndefaultProjectDir: ${projectsDir}\n---\n`,
  );

  const projectDir = join(projectsDir, 'acme');
  await mkdir(projectDir, { recursive: true });
  await writeFile(
    join(projectDir, 'project.md'),
    `---\nslug: acme\ntitle: Acme\nworkspace: acme-ws\n---\n# Acme\n`,
  );

  const aDir = join(projectDir, 'tickets', 'build-widget');
  await mkdir(aDir, { recursive: true });
  await writeFile(
    join(aDir, 'ticket.md'),
    `---\nid: 11111111-1111-1111-1111-111111111111\nslug: build-widget\ntitle: Build Widget\ntype: feature\nstatus: in_progress\n---\n# Build Widget\n\nThe widget ticket body.\n`,
  );
  await writeFile(
    join(aDir, 'comments.md'),
    `---\nticket: build-widget\n---\n# Comments\n\nA comment mentioning the widget feature.\n`,
  );

  const sDir = join(ticketsDir, '22222222-2222-2222-2222-222222222222');
  await mkdir(sDir, { recursive: true });
  await writeFile(
    join(sDir, 'ticket.md'),
    `---\nid: 22222222-2222-2222-2222-222222222222\nslug: solo-widget\ntitle: Solo Widget\ntype: chore\nstatus: pending\n---\n# Solo Widget\n\nA standalone widget task.\n`,
  );
}

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'syntaur-search-cmd-'));
  origSyntaurHome = process.env.SYNTAUR_HOME;
  process.env.SYNTAUR_HOME = testDir;
  await seedHome(testDir);
});

afterEach(async () => {
  if (origSyntaurHome === undefined) delete process.env.SYNTAUR_HOME;
  else process.env.SYNTAUR_HOME = origSyntaurHome;
  await rm(testDir, { recursive: true, force: true });
});

describe('runSearch', () => {
  it('returns the JSON-contract shape with project/ticket as slugs', async () => {
    const hits = await runSearch('widget', {});
    expect(hits.length).toBeGreaterThan(0);

    const nested = hits.find((h) => h.fileKind === 'ticket' && !h.standalone);
    expect(nested).toBeDefined();
    expect(nested!.projectSlug).toBe('acme');
    expect(nested!.ticketSlug).toBe('build-widget');

    for (const h of hits) {
      expect(typeof h.path).toBe('string');
      expect(typeof h.fileKind).toBe('string');
      expect(typeof h.score).toBe('number');
      expect(typeof h.snippet).toBe('string');
      expect(typeof h.line).toBe('number');
      expect(typeof h.route).toBe('string');
      expect(h.snippet).not.toContain('**');
    }
  });

  it('indexes ticket, comments, and standalone content kinds', async () => {
    const hits = await runSearch('widget', { limit: '50' });
    const kinds = new Set(hits.map((h) => h.fileKind));
    expect(kinds.has('ticket')).toBe(true);
    expect(kinds.has('comments')).toBe(true);
  });

  it('--project filter narrows results to one project', async () => {
    const all = await runSearch('widget', { limit: '50' });
    expect(all.some((h) => h.standalone)).toBe(true);

    const scoped = await runSearch('widget', { project: 'acme', limit: '50' });
    expect(scoped.length).toBeGreaterThan(0);
    for (const h of scoped) {
      expect(h.projectSlug).toBe('acme');
      expect(h.standalone).toBe(false);
    }
  });

  it('--in filter narrows by file kind (alias resolved)', async () => {
    const onlyComments = await runSearch('widget', { in: 'comments', limit: '50' });
    expect(onlyComments.length).toBeGreaterThan(0);
    for (const h of onlyComments) {
      expect(h.fileKind).toBe('comments');
    }
  });

  it('--in throws a clean error (caught by the command) on an unknown kind', async () => {
    await expect(runSearch('widget', { in: 'bogus', limit: '50' })).rejects.toThrow(
      /Unknown file kind "bogus"/,
    );
  });
});
