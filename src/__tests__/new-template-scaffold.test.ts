import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { createProjectCommand } from '../commands/create-project.js';
import { newCommand } from '../commands/new.js';
import { seedMissingBuiltins } from '../ticket-templates/builtins.js';
import { parseTicketFrontmatter } from '../lifecycle/frontmatter.js';
import { fileExists } from '../utils/fs.js';

let testDir: string;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'new-template-scaffold-'));
  process.env.SYNTAUR_HOME = testDir;
  await seedMissingBuiltins(testDir);
  await createProjectCommand('Demo', { slug: 'demo', dir: testDir });
  const projectMd = resolve(testDir, 'demo', 'project.md');
  const projectContent = await readFile(projectMd, 'utf-8');
  await writeFile(
    projectMd,
    projectContent.replace('defaultTemplate: feature', 'defaultTemplate: spike'),
  );
});

afterEach(async () => {
  delete process.env.SYNTAUR_HOME;
  await rm(testDir, { recursive: true, force: true });
});

async function filesInLatestTicket(): Promise<{ dir: string; names: string[] }> {
  const ticketsRoot = resolve(testDir, 'demo', 'tickets');
  const [folder] = await readdir(ticketsRoot);
  const dir = join(ticketsRoot, folder);
  const names = await readdir(dir);
  return { dir, names };
}

describe('new -t template scaffolding', () => {
  it('feature creates journal.md only at ticket-creation', async () => {
    await newCommand('Feature work', { project: 'demo', template: 'feature', dir: testDir, silent: true });
    const { names } = await filesInLatestTicket();
    expect(names).toContain('ticket.md');
    expect(names).toContain('journal.md');
    expect(names).not.toContain('plan.md');
    expect(names).not.toContain('progress.md');
  });

  it('bug creates journal.md only at ticket-creation', async () => {
    await newCommand('Bug fix', { project: 'demo', template: 'bug', dir: testDir, silent: true });
    const { names } = await filesInLatestTicket();
    expect(names).toContain('journal.md');
    expect(names).not.toContain('plan.md');
  });

  it('spike creates notes.md only at ticket-creation', async () => {
    await newCommand('Spike', { project: 'demo', template: 'spike', dir: testDir, silent: true });
    const { names } = await filesInLatestTicket();
    expect(names).toContain('notes.md');
    expect(names).not.toContain('findings.md');
  });

  it('quick creates no template files', async () => {
    await newCommand('Quick chore', { project: 'demo', template: 'quick', dir: testDir, silent: true });
    const { names } = await filesInLatestTicket();
    expect(names).toEqual(['ticket.md']);
  });

  it('legacy creates the six v1 companion files and sets plan.file', async () => {
    await newCommand('Legacy ticket', { project: 'demo', template: 'legacy', dir: testDir, silent: true });
    const { dir, names } = await filesInLatestTicket();
    for (const f of [
      'progress.md',
      'plan.md',
      'scratchpad.md',
      'decision-record.md',
      'handoff.md',
      'comments.md',
    ]) {
      expect(names).toContain(f);
    }
    const fm = parseTicketFrontmatter(await readFile(resolve(dir, 'ticket.md'), 'utf-8'));
    expect(fm.plan.file).toBe('plan.md');
  });

  it('defaults to project defaultTemplate (spike)', async () => {
    await newCommand('Defaulted', { project: 'demo', dir: testDir, silent: true });
    const { names } = await filesInLatestTicket();
    expect(names).toContain('notes.md');
    expect(await fileExists(resolve(testDir, 'demo', 'tickets', (await readdir(resolve(testDir, 'demo', 'tickets')))[0], 'journal.md'))).toBe(false);
  });
});
