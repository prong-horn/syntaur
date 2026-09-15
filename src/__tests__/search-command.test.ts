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
  const ticketsPath = join(root, 'tickets');

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

  const aDir = join(projectDir, 'tickets', 'WID-1-build-widget');
  await mkdir(aDir, { recursive: true });
  await writeFile(
    join(aDir, 'ticket.md'),
    `---\nid: WID-1\nslug: build-widget\ntitle: Build Widget\ntemplate: feature\nstatus: in_progress\n---\n# Build Widget\n\nThe widget ticket body.\n`,
  );
  await writeFile(
    join(aDir, 'comments.md'),
    `---\nticket: build-widget\n---\n# Comments\n\nA comment mentioning the widget feature.\n`,
  );

  const otherProject = join(projectsDir, 'other');
  await mkdir(otherProject, { recursive: true });
  await writeFile(
    join(otherProject, 'project.md'),
    `---\nslug: other\ntitle: Other\nworkspace: other-ws\n---\n# Other\n`,
  );
  const oDir = join(otherProject, 'tickets', 'WID-2-other-widget');
  await mkdir(oDir, { recursive: true });
  await writeFile(
    join(oDir, 'ticket.md'),
    `---\nid: WID-2\nslug: other-widget\ntitle: Other Widget\ntemplate: chore\nstatus: pending\n---\n# Other Widget\n\nAnother widget mention.\n`,
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

    const nested = hits.find((h) => h.fileKind === 'ticket' && h.projectSlug === 'acme');
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
    expect(all.some((h) => h.projectSlug === 'other')).toBe(true);

    const scoped = await runSearch('widget', { project: 'acme', limit: '50' });
    expect(scoped.length).toBeGreaterThan(0);
    for (const h of scoped) {
      expect(h.projectSlug).toBe('acme');
      expect(h.standalone).toBe(false);
    }
    expect(scoped.some((h) => h.projectSlug === 'other')).toBe(false);
  });

  it('--in filter narrows by file kind (alias resolved)', async () => {
    const onlyComments = await runSearch('widget', { in: 'comments', limit: '50' });
    expect(onlyComments.length).toBeGreaterThan(0);
    for (const h of onlyComments) {
      expect(h.fileKind).toBe('comments');
    }
  });

  it('--in journal resolves the journal file kind', async () => {
    const aDir = join(testDir, 'projects', 'acme', 'tickets', 'WID-1-build-widget');
    await writeFile(
      join(aDir, 'journal.md'),
      `---\npurpose: Search test journal\n---\n\n## 2026-01-01T12:00:00Z · note · human\n\nwidget in the journal.\n`,
    );
    const onlyJournal = await runSearch('widget', { in: 'journal', limit: '50' });
    expect(onlyJournal.length).toBeGreaterThan(0);
    for (const h of onlyJournal) {
      expect(h.fileKind).toBe('journal');
    }
  });

  it('--in throws a clean error (caught by the command) on an unknown kind', async () => {
    await expect(runSearch('widget', { in: 'bogus', limit: '50' })).rejects.toThrow(
      /Unknown file kind "bogus"/,
    );
  });
});
