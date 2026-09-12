import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, readdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { newCommand } from '../commands/new.js';
import { renameCommand } from '../commands/rename.js';
import { projectNewCommand } from '../commands/project.js';
import { REQUIRED_PROJECT_SCAFFOLD_FILES } from '../utils/project-scaffold.js';
import { buildCheckContext, closeCheckContext } from '../utils/doctor/context.js';
import { projectChecks } from '../utils/doctor/checks/project.js';

let testDir: string;
let origHome: string | undefined;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'syntaur-rename-'));
  origHome = process.env.SYNTAUR_HOME;
  process.env.SYNTAUR_HOME = testDir;
  await mkdtemp(join(testDir, 'projects-placeholder-'));
  const projectsDir = resolve(testDir, 'projects');
  await import('node:fs/promises').then((fs) => fs.mkdir(projectsDir, { recursive: true }));
});

afterEach(async () => {
  if (origHome === undefined) delete process.env.SYNTAUR_HOME;
  else process.env.SYNTAUR_HOME = origHome;
  await rm(testDir, { recursive: true, force: true });
});

describe('scratch project', () => {
  it('creates SCR-1 and SCR-2 when new has no --project', async () => {
    const first = await newCommand('One', { dir: resolve(testDir, 'projects'), silent: true });
    const second = await newCommand('Two', { dir: resolve(testDir, 'projects'), silent: true });
    expect(first.id).toBe('SCR-1');
    expect(second.id).toBe('SCR-2');
    const scratchDir = resolve(testDir, 'projects', 'scratch');
    const scratchTickets = resolve(scratchDir, 'tickets');
    const folders = await readdir(scratchTickets);
    expect(folders.sort()).toEqual(['SCR-1-one', 'SCR-2-two']);

    for (const file of REQUIRED_PROJECT_SCAFFOLD_FILES) {
      await expect(stat(resolve(scratchDir, file))).resolves.toBeDefined();
    }

    const ctx = await buildCheckContext();
    const check = projectChecks.find((c) => c.id === 'project.required-files-present')!;
    const result = await check.run(ctx);
    closeCheckContext(ctx);
    const issues = Array.isArray(result) ? result : [result];
    expect(issues.every((r) => r.status !== 'error')).toBe(true);
  });
});

describe('rename', () => {
  it('renames the folder and slug field while preserving the id', async () => {
    await projectNewCommand('Demo', { slug: 'demo', dir: resolve(testDir, 'projects'), silent: true });
    const created = await newCommand('Alpha', {
      project: 'demo',
      dir: resolve(testDir, 'projects'),
      silent: true,
    });
    await renameCommand(created.id, 'beta', { dir: resolve(testDir, 'projects') });
    const ticketDir = resolve(testDir, 'projects', 'demo', 'tickets', `${created.id}-beta`);
    const content = await readFile(resolve(ticketDir, 'ticket.md'), 'utf-8');
    expect(content).toContain(`id: ${created.id}`);
    expect(content).toContain('slug: beta');
  });
});
