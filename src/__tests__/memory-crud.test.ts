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

describe('syntaur memory CRUD', () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'syntaur-mem-'));
    await writeFile(resolve(home, 'config.md'), '---\nversion: "2.0"\n---\n', 'utf-8');
    await mkdir(resolve(home, 'projects', 'p'), { recursive: true });
    await writeFile(resolve(home, 'projects', 'p', 'project.md'), '---\nslug: p\ntitle: "P"\n---\n# P\n', 'utf-8');
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('add → list → show → update → remove with _index.md regeneration', async () => {
    expect((await runCli(['memory', 'add', '--project', 'p', '--name', 'Decision X', '--source', 'convo'], home)).code).toBe(0);

    const rows = JSON.parse((await runCli(['memory', 'list', '--project', 'p', '--json'], home)).stdout);
    expect(rows).toHaveLength(1);
    expect(rows[0].slug).toBe('decision-x');
    expect(rows[0].scope).toBe('project');

    const upd = await runCli(['memory', 'update', 'decision-x', '--project', 'p', '--scope', 'global'], home);
    expect(upd.code, upd.stderr).toBe(0);
    const index = await readFile(resolve(home, 'projects', 'p', 'memories', '_index.md'), 'utf-8');
    expect(index).toContain('global');
    expect(JSON.parse((await runCli(['memory', 'show', 'decision-x', '--project', 'p', '--json'], home)).stdout).scope).toBe('global');

    expect((await runCli(['memory', 'remove', 'decision-x', '--project', 'p'], home)).code).toBe(0);
    expect(JSON.parse((await runCli(['memory', 'list', '--project', 'p', '--json'], home)).stdout)).toHaveLength(0);
  });

  it('update requires at least one field', async () => {
    await runCli(['memory', 'add', '--project', 'p', '--name', 'M', '--source', 's'], home);
    const r = await runCli(['memory', 'update', 'm', '--project', 'p'], home);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('at least one');
  });
});
