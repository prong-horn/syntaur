import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runSearch } from '../commands/search.js';

let testDir: string;
let origSyntaurHome: string | undefined;

/**
 * Seed a SYNTAUR_HOME with one project (workspace `acme-ws`) containing one
 * assignment (assignment.md + comments.md) and one memory, plus a standalone
 * assignment. Each file body carries the searchable term "widget".
 */
async function seedHome(root: string): Promise<void> {
  const projectsDir = join(root, 'projects');
  const assignmentsDir = join(root, 'assignments');

  // `readConfig()` resolves `defaultProjectDir` from config.md (its in-code
  // default is captured at module load, before SYNTAUR_HOME is overridden), so
  // an explicit config.md is required to point the search at this temp tree.
  await mkdir(root, { recursive: true });
  await writeFile(
    join(root, 'config.md'),
    `---\nversion: "2.0"\ndefaultProjectDir: ${projectsDir}\n---\n`,
  );

  // ── project + nested assignment ─────────────────────────────────────────
  const projectDir = join(projectsDir, 'acme');
  await mkdir(projectDir, { recursive: true });
  await writeFile(
    join(projectDir, 'project.md'),
    `---\nslug: acme\ntitle: Acme\nworkspace: acme-ws\n---\n# Acme\n`,
  );

  const aDir = join(projectDir, 'assignments', 'build-widget');
  await mkdir(aDir, { recursive: true });
  await writeFile(
    join(aDir, 'assignment.md'),
    `---\nid: 11111111-1111-1111-1111-111111111111\nslug: build-widget\ntitle: Build Widget\ntype: feature\nstatus: in_progress\n---\n# Build Widget\n\nThe widget assignment body.\n`,
  );
  await writeFile(
    join(aDir, 'comments.md'),
    `---\nassignment: build-widget\n---\n# Comments\n\nA comment mentioning the widget feature.\n`,
  );

  // ── project memory ──────────────────────────────────────────────────────
  const memDir = join(projectDir, 'memories');
  await mkdir(memDir, { recursive: true });
  await writeFile(
    join(memDir, 'widget-lore.md'),
    `---\nname: Widget Lore\nscope: project\n---\nDeep widget knowledge captured here.\n`,
  );

  // ── standalone assignment ───────────────────────────────────────────────
  const sDir = join(assignmentsDir, '22222222-2222-2222-2222-222222222222');
  await mkdir(sDir, { recursive: true });
  await writeFile(
    join(sDir, 'assignment.md'),
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
  it('returns the JSON-contract shape with project/assignment as slugs', async () => {
    const hits = await runSearch('widget', {});
    expect(hits.length).toBeGreaterThan(0);

    // Find the nested-assignment hit to assert the slug contract.
    const nested = hits.find((h) => h.fileKind === 'assignment' && !h.standalone);
    expect(nested).toBeDefined();
    expect(nested!.projectSlug).toBe('acme');
    expect(nested!.assignmentSlug).toBe('build-widget');

    // Every hit exposes the full contract surface (internal field names).
    for (const h of hits) {
      expect(typeof h.path).toBe('string');
      expect(typeof h.fileKind).toBe('string');
      expect(typeof h.score).toBe('number');
      expect(typeof h.snippet).toBe('string');
      expect(typeof h.line).toBe('number');
      expect(typeof h.route).toBe('string');
      // neutral snippet — no CLI highlight markers baked in by the provider
      expect(h.snippet).not.toContain('**');
    }
  });

  it('indexes every content kind (assignment, comments, memory, standalone)', async () => {
    const hits = await runSearch('widget', { limit: '50' });
    const kinds = new Set(hits.map((h) => h.fileKind));
    expect(kinds.has('assignment')).toBe(true);
    expect(kinds.has('comments')).toBe(true);
    expect(kinds.has('memory')).toBe(true);

    const memoryHit = hits.find((h) => h.fileKind === 'memory');
    expect(memoryHit!.projectSlug).toBe('acme');
    expect(memoryHit!.itemSlug).toBe('widget-lore');
    expect(memoryHit!.assignmentSlug).toBeNull();
    expect(memoryHit!.route).toBe('/projects/acme/memories/widget-lore');
  });

  it('--project filter narrows results to one project', async () => {
    const all = await runSearch('widget', { limit: '50' });
    expect(all.some((h) => h.standalone)).toBe(true);

    const scoped = await runSearch('widget', { project: 'acme', limit: '50' });
    expect(scoped.length).toBeGreaterThan(0);
    // No standalone hits and no other-project hits leak through.
    for (const h of scoped) {
      expect(h.projectSlug).toBe('acme');
      expect(h.standalone).toBe(false);
    }
  });

  it('--in filter narrows by file kind (alias resolved)', async () => {
    const onlyComments = await runSearch('widget', { in: ['comments'], limit: '50' });
    expect(onlyComments.length).toBeGreaterThan(0);
    for (const h of onlyComments) {
      expect(h.fileKind).toBe('comments');
    }
  });
});
