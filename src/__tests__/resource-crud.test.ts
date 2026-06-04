import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';

const CLI_ENTRY = resolve(__dirname, '..', '..', 'bin', 'syntaur.js');

interface RunResult { code: number; stdout: string; stderr: string }

async function runCli(args: string[], home: string): Promise<RunResult> {
  return new Promise((res) => {
    const child = spawn(process.execPath, [CLI_ENTRY, ...args], {
      env: { ...process.env, SYNTAUR_HOME: home },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('close', (code) => res({ code: code ?? -1, stdout, stderr }));
  });
}

describe('syntaur resource CRUD', () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'syntaur-res-'));
    await writeFile(resolve(home, 'config.md'), '---\nversion: "2.0"\n---\n', 'utf-8');
    await mkdir(resolve(home, 'projects', 'p'), { recursive: true });
    await writeFile(resolve(home, 'projects', 'p', 'project.md'), '---\nslug: p\ntitle: "P"\n---\n# P\n', 'utf-8');
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('add → list → show → update → remove with _index.md regeneration', async () => {
    expect((await runCli(['resource', 'add', '--project', 'p', '--name', 'Dash', '--source', 'https://x', '--category', 'dashboard'], home)).code).toBe(0);

    const list = await runCli(['resource', 'list', '--project', 'p', '--json'], home);
    expect(list.code, list.stderr).toBe(0);
    const rows = JSON.parse(list.stdout);
    expect(rows).toHaveLength(1);
    expect(rows[0].slug).toBe('dash');

    const show = await runCli(['resource', 'show', 'dash', '--project', 'p', '--json'], home);
    expect(JSON.parse(show.stdout).category).toBe('dashboard');

    // Two updates in a row must not stack duplicate "# <name>" headings.
    await runCli(['resource', 'update', 'dash', '--project', 'p', '--category', 'ops'], home);
    const upd = await runCli(['resource', 'update', 'dash', '--project', 'p', '--category', 'ops2'], home);
    expect(upd.code, upd.stderr).toBe(0);
    const file = await readFile(resolve(home, 'projects', 'p', 'resources', 'dash.md'), 'utf-8');
    expect((file.match(/^# /gm) ?? []).length).toBe(1);
    // _index.md reflects the update (not just add).
    const index = await readFile(resolve(home, 'projects', 'p', 'resources', '_index.md'), 'utf-8');
    expect(index).toContain('ops2');
    expect(JSON.parse((await runCli(['resource', 'show', 'dash', '--project', 'p', '--json'], home)).stdout).category).toBe('ops2');

    const rm1 = await runCli(['resource', 'remove', 'dash', '--project', 'p'], home);
    expect(rm1.code, rm1.stderr).toBe(0);
    expect(JSON.parse((await runCli(['resource', 'list', '--project', 'p', '--json'], home)).stdout)).toHaveLength(0);
  });

  it('show/update/remove error on a missing slug', async () => {
    expect((await runCli(['resource', 'show', 'nope', '--project', 'p'], home)).code).toBe(1);
    expect((await runCli(['resource', 'update', 'nope', '--project', 'p', '--name', 'X'], home)).code).toBe(1);
    expect((await runCli(['resource', 'remove', 'nope', '--project', 'p'], home)).code).toBe(1);
  });
});
