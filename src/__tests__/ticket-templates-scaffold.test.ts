import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { injectPurpose, scaffoldTemplateFiles } from '../ticket-templates/scaffold.js';
import { loadTemplate } from '../ticket-templates/registry.js';
import { seedMissingBuiltins, builtinTemplatesDir } from '../ticket-templates/builtins.js';
import { fileExists } from '../utils/fs.js';

let home: string;
let ticketDir: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'scaffold-test-'));
  await seedMissingBuiltins(home);
  ticketDir = join(home, 'ticket');
  await mkdir(ticketDir, { recursive: true });
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe('injectPurpose', () => {
  it('inserts purpose as the first frontmatter key when absent', () => {
    const out = injectPurpose('# Notes\n', 'Scratch notes');
    expect(out).toContain('purpose: Scratch notes');
    expect(out.indexOf('purpose:')).toBeLessThan(out.indexOf('# Notes'));
  });

  it('replaces an existing purpose key', () => {
    const out = injectPurpose('---\nfoo: bar\n---\n\n# X\n', 'New purpose');
    expect(out).toMatch(/^---\npurpose: New purpose\nfoo: bar\n---/);
  });
});

describe('scaffoldTemplateFiles', () => {
  it('never overwrites an existing file', async () => {
    const manifest = await loadTemplate(home, 'feature');
    const templateDir = resolve(builtinTemplatesDir(), 'feature');
    await writeFile(join(ticketDir, 'journal.md'), 'KEEP\n', 'utf-8');
    const written = await scaffoldTemplateFiles({
      ticketDir,
      templateDir,
      template: manifest,
      ticketSlug: 'demo',
      timestamp: '2026-04-20T12:00:00Z',
      when: 'ticket-creation',
    });
    expect(written).not.toContain('journal.md');
    expect(await readFile(join(ticketDir, 'journal.md'), 'utf-8')).toBe('KEEP\n');
  });

  it('writes ticket-creation files for feature (journal only)', async () => {
    const manifest = await loadTemplate(home, 'feature');
    const templateDir = resolve(builtinTemplatesDir(), 'feature');
    const written = await scaffoldTemplateFiles({
      ticketDir,
      templateDir,
      template: manifest,
      ticketSlug: 'demo',
      timestamp: '2026-04-20T12:00:00Z',
      when: 'ticket-creation',
    });
    expect(written).toEqual(['journal.md']);
    const journal = await readFile(join(ticketDir, 'journal.md'), 'utf-8');
    expect(journal).toContain('purpose:');
    expect(await fileExists(join(ticketDir, 'plan.md'))).toBe(false);
  });

  it('scaffolds via only for createOn: never plan paths', async () => {
    const manifest = await loadTemplate(home, 'bug');
    const templateDir = resolve(builtinTemplatesDir(), 'bug');
    const written = await scaffoldTemplateFiles({
      ticketDir,
      templateDir,
      template: manifest,
      ticketSlug: 'demo',
      timestamp: '2026-04-20T12:00:00Z',
      only: ['plan.md'],
    });
    expect(written).toEqual(['plan.md']);
    expect(await fileExists(join(ticketDir, 'journal.md'))).toBe(false);
  });
});
