import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { renderTicket } from '../templates/index.js';
import { createProjectCommand } from '../commands/create-project.js';
import { newCommand } from '../commands/new.js';
import { seedMissingBuiltins } from '../ticket-templates/builtins.js';
import { extractFrontmatter, getField } from '../dashboard/parser.js';

let testDir: string;
let origSyntaurHome: string | undefined;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'syntaur-template-test-'));
  origSyntaurHome = process.env.SYNTAUR_HOME;
  process.env.SYNTAUR_HOME = testDir;
  await seedMissingBuiltins(testDir);
});

afterEach(async () => {
  if (origSyntaurHome === undefined) delete process.env.SYNTAUR_HOME;
  else process.env.SYNTAUR_HOME = origSyntaurHome;
  await rm(testDir, { recursive: true, force: true });
});

describe('ticket template field', () => {
  it('renders an explicit template into the frontmatter', () => {
    const out = renderTicket({
      id: 'id-1',
      slug: 'fix-thing',
      title: 'Fix thing',
      timestamp: '2026-04-20T00:00:00Z',
      priority: 'medium',
      depends_on: [],
      links: [],
      project: 'proj',
      template: 'bug',
    });
    expect(out).toContain('template: bug');
    expect(out).not.toContain('type:');
  });

  it('new -t round-trips template through CLI and parser', async () => {
    await createProjectCommand('P', { dir: testDir });
    await newCommand('Fix a bug', {
      project: 'p',
      template: 'bug',
      dir: testDir,
    });

    const ticketsPath = resolve(testDir, 'p', 'tickets');
    const [folder] = await readdir(ticketsPath);
    const ticketMd = await readFile(resolve(ticketsPath, folder, 'ticket.md'), 'utf-8');
    expect(ticketMd).toContain('template: bug');

    const [fm] = extractFrontmatter(ticketMd);
    expect(getField(fm, 'template')).toBe('bug');
  });

  it('rejects unknown template', async () => {
    await createProjectCommand('P', { dir: testDir });
    await expect(
      newCommand('Nope', { project: 'p', template: 'not-a-template', dir: testDir }),
    ).rejects.toThrow(/Unknown template/);
  });
});
