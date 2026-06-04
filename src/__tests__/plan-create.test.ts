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

const ASSIGNMENT = `---
id: aaaa
slug: a
title: "A"
status: in_progress
created: "2026-01-01T00:00:00Z"
updated: "2026-01-01T00:00:00Z"
---
# A

## Todos

- [ ] Something
`;

describe('syntaur plan create', () => {
  let home: string;
  let assignmentDir: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'syntaur-plan-'));
    await writeFile(resolve(home, 'config.md'), `---\nversion: "2.0"\ndefaultProjectDir: ${resolve(home, 'projects')}\n---\n`, 'utf-8');
    assignmentDir = resolve(home, 'projects', 'p', 'assignments', 'a');
    await mkdir(assignmentDir, { recursive: true });
    await writeFile(resolve(home, 'projects', 'p', 'project.md'), '---\nslug: p\ntitle: "P"\n---\n# P\n', 'utf-8');
    await writeFile(resolve(assignmentDir, 'assignment.md'), ASSIGNMENT, 'utf-8');
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('writes an initial plan.md (no Supersedes/v<N>) and appends the todo cycle', async () => {
    const r = await runCli(['plan', 'create', '--assignment', 'a', '--project', 'p'], home);
    expect(r.code, r.stderr).toBe(0);

    const plan = await readFile(resolve(assignmentDir, 'plan.md'), 'utf-8');
    expect(plan).toContain('# a — Implementation Plan');
    expect(plan).not.toContain('Supersedes');
    expect(plan).not.toContain('Implementation Plan v');
    expect(plan).toContain('status: draft');

    const assignment = await readFile(resolve(assignmentDir, 'assignment.md'), 'utf-8');
    expect(assignment).toContain('- [ ] Create [plan](./plan.md)');
    expect(assignment).toContain('- [ ] Review implementation of [plan](./plan.md)');
  });

  it('refuses to overwrite an existing plan.md without --force', async () => {
    await runCli(['plan', 'create', '--assignment', 'a', '--project', 'p'], home);
    const again = await runCli(['plan', 'create', '--assignment', 'a', '--project', 'p'], home);
    expect(again.code).toBe(1);
    expect(again.stderr).toContain('already exists');
    const forced = await runCli(['plan', 'create', '--assignment', 'a', '--project', 'p', '--force'], home);
    expect(forced.code, forced.stderr).toBe(0);
  });
});
