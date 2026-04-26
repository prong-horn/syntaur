import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, readFile, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';

const CLI_ENTRY = resolve(__dirname, '..', '..', 'bin', 'syntaur.js');

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function runCli(args: string[], syntaurHome: string): Promise<RunResult> {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [CLI_ENTRY, ...args], {
      env: { ...process.env, SYNTAUR_HOME: syntaurHome },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    child.on('close', (code) => {
      resolvePromise({ code: code ?? -1, stdout, stderr });
    });
  });
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

let syntaurHome: string;
let projectsDir: string;

beforeEach(async () => {
  syntaurHome = await mkdtemp(join(tmpdir(), 'syntaur-cli-todo-'));
  projectsDir = resolve(syntaurHome, 'projects');
  await mkdir(projectsDir, { recursive: true });
  await writeFile(
    resolve(syntaurHome, 'config.md'),
    `---\nversion: "2.0"\ndefaultProjectDir: ${projectsDir}\nonboarding:\n  completed: true\n---\n`,
  );
});

afterEach(async () => {
  await rm(syntaurHome, { recursive: true, force: true });
});

async function seedProject(slug: string): Promise<void> {
  await mkdir(resolve(projectsDir, slug), { recursive: true });
  await writeFile(
    resolve(projectsDir, slug, 'project.md'),
    `---\nid: ${slug}-id\nslug: ${slug}\ntitle: ${slug}\n---\n# ${slug}\n`,
  );
}

describe('syntaur todo CLI scope resolution', () => {
  it('(g) no-flag default writes to <SYNTAUR_HOME>/todos/_global.md', async () => {
    const res = await runCli(['todo', 'add', 'no-flag-default'], syntaurHome);
    expect(res.code).toBe(0);
    const content = await readFile(resolve(syntaurHome, 'todos', '_global.md'), 'utf-8');
    expect(content).toContain('no-flag-default');
    expect(content).toMatch(/^---\nworkspace: _global\n/m);
  });

  it('(h) --project ghost (no directory) fails without creating it', async () => {
    const res = await runCli(['todo', 'add', 'x', '--project', 'ghost'], syntaurHome);
    expect(res.code).not.toBe(0);
    expect(res.stderr + res.stdout).toMatch(/not found/i);
    expect(await pathExists(resolve(projectsDir, 'ghost'))).toBe(false);
  });

  it('(i) --project + --workspace errors with "at most one"', async () => {
    await seedProject('alpha');
    const res = await runCli(
      ['todo', 'add', 'x', '--project', 'alpha', '--workspace', 'wsname'],
      syntaurHome,
    );
    expect(res.code).not.toBe(0);
    expect(res.stderr + res.stdout).toMatch(/at most one/i);
  });

  it('(j) empty dir with no project.md still rejects as not found (does not create todos/)', async () => {
    await mkdir(resolve(projectsDir, 'empty-shell'), { recursive: true });
    const res = await runCli(['todo', 'add', 'x', '--project', 'empty-shell'], syntaurHome);
    expect(res.code).not.toBe(0);
    expect(res.stderr + res.stdout).toMatch(/not found/i);
    expect(await pathExists(resolve(projectsDir, 'empty-shell', 'todos'))).toBe(false);
  });

  it('--project <valid> writes under <projectsDir>/<slug>/todos/<slug>.md', async () => {
    await seedProject('alpha');
    const res = await runCli(['todo', 'add', 'first', '--project', 'alpha'], syntaurHome);
    expect(res.code).toBe(0);
    const content = await readFile(
      resolve(projectsDir, 'alpha', 'todos', 'alpha.md'),
      'utf-8',
    );
    expect(content).toContain('first');
    expect(content).toMatch(/^---\nworkspace: alpha\n/m);
  });
});
