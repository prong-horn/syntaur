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

const WELL_FORMED = `---
id: aaaa-1111
slug: a
title: "A"
status: pending
project: p
created: "2026-01-01T00:00:00Z"
updated: "2026-01-01T00:00:00Z"
customField: keepme
workspace:
  repository: null
  worktreePath: null
  branch: null
  parentBranch: null
---
# A
`;

describe('syntaur workspace set', () => {
  let home: string;
  let assignmentPath: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'syntaur-ws-'));
    const dir = resolve(home, 'projects', 'p', 'assignments', 'a');
    await mkdir(dir, { recursive: true });
    assignmentPath = resolve(dir, 'assignment.md');
    await writeFile(assignmentPath, WELL_FORMED, 'utf-8');
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('writes all four workspace fields, bumps updated, preserves unrelated frontmatter', async () => {
    const r = await runCli(
      [
        'workspace', 'set', '--assignment', 'a', '--project', 'p',
        '--repository', '/repo', '--worktree-path', '/repo/.worktrees/feat',
        '--branch', 'feat', '--parent-branch', 'main',
      ],
      home,
    );
    expect(r.code, r.stderr).toBe(0);
    const content = await readFile(assignmentPath, 'utf-8');
    expect(content).toContain('repository: /repo');
    expect(content).toContain('worktreePath: /repo/.worktrees/feat');
    expect(content).toContain('branch: feat');
    expect(content).toContain('parentBranch: main');
    expect(content).toContain('customField: keepme'); // unrelated frontmatter preserved
    expect(content).not.toContain('updated: "2026-01-01T00:00:00Z"'); // updated bumped
  });

  it('requires at least one field flag', async () => {
    const r = await runCli(['workspace', 'set', '--assignment', 'a', '--project', 'p'], home);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('at least one');
  });

  it('refuses to write a malformed assignment (pre-validation)', async () => {
    // Missing required id/title/status → validateAssignmentFile fails.
    await writeFile(assignmentPath, '---\nslug: a\n---\n# A\n', 'utf-8');
    const r = await runCli(
      ['workspace', 'set', '--assignment', 'a', '--project', 'p', '--branch', 'feat'],
      home,
    );
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('invalid');
    // The file was not modified.
    expect(await readFile(assignmentPath, 'utf-8')).toBe('---\nslug: a\n---\n# A\n');
  });
});
