import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { templateCommand } from '../commands/template.js';
import { seedMissingBuiltins } from '../ticket-templates/builtins.js';

async function runTemplate(args: string[], home: string): Promise<{ code: number; out: string; err: string }> {
  const prior = process.env.SYNTAUR_HOME;
  process.env.SYNTAUR_HOME = home;
  const logs: string[] = [];
  const errors: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...a: unknown[]) => logs.push(a.join(' '));
  console.error = (...a: unknown[]) => errors.push(a.join(' '));

  let code = 0;
  try {
    await templateCommand.parseAsync(['node', 'template', ...args]);
    code = process.exitCode ?? 0;
  } catch {
    code = process.exitCode ?? 1;
  } finally {
    console.log = origLog;
    console.error = origErr;
    if (prior === undefined) delete process.env.SYNTAUR_HOME;
    else process.env.SYNTAUR_HOME = prior;
    process.exitCode = undefined;
  }
  return { code, out: logs.join('\n'), err: errors.join('\n') };
}

describe('template command', () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'syntaur-template-cmd-'));
    await seedMissingBuiltins(home);
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('list shows built-ins', async () => {
    const { code, out } = await runTemplate(['list'], home);
    expect(code).toBe(0);
    expect(out).toContain('feature');
    expect(out).toContain('legacy');
  });

  it('new copies a built-in and rewrites id', async () => {
    const { code } = await runTemplate(['new', 'my-feature', '--from', 'feature'], home);
    expect(code).toBe(0);
    const content = await readFile(resolve(home, 'templates', 'my-feature', 'template.md'), 'utf-8');
    expect(content).toMatch(/^id: my-feature/m);
    expect(content).not.toMatch(/^builtin:/m);
  });

  it('check exits 1 on issues', async () => {
    const { code } = await runTemplate(['check', 'feature', '--builtins'], home);
    expect(code).toBe(0);

    const badDir = resolve(home, 'templates', 'bad');
    const { mkdir, writeFile } = await import('node:fs/promises');
    await mkdir(badDir, { recursive: true });
    await writeFile(
      resolve(badDir, 'template.md'),
      '---\nid: bad\nversion: 2\ndescription: x\nwhenToUse: x\nstages: []\nfiles: []\n---\n',
      'utf-8',
    );
    const bad = await runTemplate(['check', 'bad'], home);
    expect(bad.code).toBe(1);
    expect(bad.err).toMatch(/rule/);
  });

  it('reset --missing seeds absent built-ins', async () => {
    const partial = await mkdtemp(join(tmpdir(), 'syntaur-partial-'));
    const { code, out } = await runTemplate(['reset', '--missing'], partial);
    expect(code).toBe(0);
    expect(out).toMatch(/Seeded/);
    await rm(partial, { recursive: true, force: true });
  });
});
