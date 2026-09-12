import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { migrateStatusHistoryCommand } from '../commands/migrate-status-history.js';
import { parseTicketFrontmatter } from '../lifecycle/frontmatter.js';

let home: string;
let projectsDir: string;
let standaloneDir: string;
let prevHome: string | undefined;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'syntaur-migrate-sh-'));
  projectsDir = resolve(home, 'projects');
  standaloneDir = resolve(home, 'tickets');
  prevHome = process.env.SYNTAUR_HOME;
  process.env.SYNTAUR_HOME = home;
});

afterEach(async () => {
  if (prevHome === undefined) delete process.env.SYNTAUR_HOME;
  else process.env.SYNTAUR_HOME = prevHome;
  await rm(home, { recursive: true, force: true });
});

function ticketMd(
  slug: string,
  status: string,
  created: string,
  updated: string,
  opts: { withHistory?: boolean; malformed?: boolean } = {},
): string {
  if (opts.malformed) return `not a valid ticket file\nno frontmatter\n`;
  const history = opts.withHistory
    ? `statusHistory:\n  - at: "${created}"\n    from: null\n    to: ${status}\n    command: create\n    by: null\n`
    : '';
  return `---
id: ${slug}-id
slug: ${slug}
title: "${slug}"
status: ${status}
priority: medium
created: "${created}"
updated: "${updated}"
assignee: null
externalIds: []
${history}dependsOn: []
links: []
blockedReason: null
workspace:
  repository: null
  worktreePath: null
  branch: null
  parentBranch: null
tags: []
---

# ${slug}
`;
}

async function seedProject(
  project: string,
  slug: string,
  status: string,
  created: string,
  updated: string,
  opts: { withHistory?: boolean; malformed?: boolean } = {},
): Promise<string> {
  const dir = resolve(projectsDir, project, 'tickets', slug);
  await mkdir(dir, { recursive: true });
  const path = resolve(dir, 'ticket.md');
  await writeFile(path, ticketMd(slug, status, created, updated, opts), 'utf-8');
  return path;
}

async function seedStandalone(
  uuid: string,
  status: string,
  created: string,
  updated: string,
  opts: { withHistory?: boolean } = {},
): Promise<string> {
  const dir = resolve(standaloneDir, uuid);
  await mkdir(dir, { recursive: true });
  const path = resolve(dir, 'ticket.md');
  await writeFile(path, ticketMd(uuid, status, created, updated, opts), 'utf-8');
  return path;
}

const C = '2026-01-01T00:00:00Z';
const U = '2026-02-02T00:00:00Z';

describe('migrateStatusHistoryCommand', () => {
  it('dry-run (default) does not write', async () => {
    const path = await seedProject('p1', 'a1', 'in_progress', C, U);
    await migrateStatusHistoryCommand({ dir: projectsDir });
    expect(parseTicketFrontmatter(await readFile(path, 'utf-8')).statusHistory).toEqual([]);
  });

  it('seeds a non-terminal ticket with at = created', async () => {
    const path = await seedProject('p1', 'a1', 'in_progress', C, U);
    await migrateStatusHistoryCommand({ dir: projectsDir, apply: true });
    const fm = parseTicketFrontmatter(await readFile(path, 'utf-8'));
    expect(fm.statusHistory).toHaveLength(1);
    expect(fm.statusHistory[0]).toEqual({
      at: C,
      from: null,
      to: 'in_progress',
      command: 'seed',
      by: null,
    });
  });

  it('seeds a terminal ticket with at = updated', async () => {
    const path = await seedProject('p1', 'done', 'completed', C, U);
    await migrateStatusHistoryCommand({ dir: projectsDir, apply: true });
    const fm = parseTicketFrontmatter(await readFile(path, 'utf-8'));
    expect(fm.statusHistory).toHaveLength(1);
    expect(fm.statusHistory[0]).toMatchObject({ at: U, to: 'completed', command: 'seed' });
  });

  it('is idempotent — second run is a no-op', async () => {
    const path = await seedProject('p1', 'a1', 'in_progress', C, U);
    await migrateStatusHistoryCommand({ dir: projectsDir, apply: true });
    await migrateStatusHistoryCommand({ dir: projectsDir, apply: true });
    expect(parseTicketFrontmatter(await readFile(path, 'utf-8')).statusHistory).toHaveLength(1);
  });

  it('skips tickets that already have statusHistory', async () => {
    const path = await seedProject('p1', 'has', 'draft', C, U, { withHistory: true });
    const before = await readFile(path, 'utf-8');
    await migrateStatusHistoryCommand({ dir: projectsDir, apply: true });
    expect(await readFile(path, 'utf-8')).toBe(before);
  });

  it('does not throw on a malformed ticket file (skips it)', async () => {
    const good = await seedProject('p1', 'a1', 'in_progress', C, U);
    await seedProject('p1', 'bad', 'in_progress', C, U, { malformed: true });
    await expect(migrateStatusHistoryCommand({ dir: projectsDir, apply: true })).resolves.toBeUndefined();
    // the good one still got seeded
    expect(parseTicketFrontmatter(await readFile(good, 'utf-8')).statusHistory).toHaveLength(1);
  });

  it('honors a CUSTOM configured terminal status (terminal → updated anchor)', async () => {
    // Custom config: `done` is terminal, `in_progress` is not.
    await writeFile(
      resolve(home, 'config.md'),
      `---\nversion: "2.0"\ndefaultProjectDir: ${projectsDir}\nstatuses:\n  definitions:\n    - id: in_progress\n      label: In Progress\n    - id: done\n      label: Done\n      terminal: true\n  order:\n    - in_progress\n    - done\n---\n`,
      'utf-8',
    );
    const donePath = await seedProject('p1', 'd1', 'done', C, U);
    const wipPath = await seedProject('p1', 'w1', 'in_progress', C, U);

    await migrateStatusHistoryCommand({ dir: projectsDir, apply: true });

    // `done` is configured terminal → anchor is `updated` (U).
    expect(parseTicketFrontmatter(await readFile(donePath, 'utf-8')).statusHistory[0]).toMatchObject({
      at: U,
      to: 'done',
      command: 'seed',
    });
    // `in_progress` is non-terminal → anchor is `created` (C).
    expect(parseTicketFrontmatter(await readFile(wipPath, 'utf-8')).statusHistory[0]).toMatchObject({
      at: C,
      to: 'in_progress',
      command: 'seed',
    });
  });

  it('seeds a standalone ticket (uuid dir under the standalone base)', async () => {
    const path = await seedStandalone('11111111-2222-3333-4444-555555555555', 'review', C, U);
    await migrateStatusHistoryCommand({ dir: projectsDir, apply: true });
    const fm = parseTicketFrontmatter(await readFile(path, 'utf-8'));
    expect(fm.statusHistory).toHaveLength(1);
    expect(fm.statusHistory[0]).toMatchObject({ to: 'review', command: 'seed', at: C });
  });
});
