import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileExists } from '../utils/fs.js';

const CLI_ENTRY = resolve(__dirname, '..', '..', 'bin', 'syntaur.js');

interface RunResult { code: number; stdout: string; stderr: string }

function runCli(args: string[], home: string): Promise<RunResult> {
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

function git(cwd: string, args: string[]): void {
  const r = spawnSync('git', args, { cwd, encoding: 'utf-8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
}

describe('syntaur open', () => {
  let home: string;
  let repo: string;

  async function writeAssignment(slug: string, worktreePath: string | null, branch: string | null): Promise<void> {
    const dir = resolve(home, 'projects', 'p', 'assignments', slug);
    await mkdir(dir, { recursive: true });
    await writeFile(
      resolve(dir, 'assignment.md'),
      `---
id: id-${slug}
slug: ${slug}
title: "${slug}"
project: p
status: in_progress
created: "2026-01-01T00:00:00Z"
updated: "2026-01-01T00:00:00Z"
archived: false
workspace:
  repository: ${worktreePath ? repo : 'null'}
  worktreePath: ${worktreePath ?? 'null'}
  branch: ${branch ?? 'null'}
  parentBranch: main
---
# ${slug}
`,
      'utf-8',
    );
  }

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'syntaur-open-'));
    repo = resolve(home, 'repo');
    await mkdir(repo, { recursive: true });
    git(repo, ['init', '-q', '-b', 'main']);
    git(repo, ['config', 'user.email', 'test@example.com']);
    git(repo, ['config', 'user.name', 'Test']);
    await writeFile(resolve(repo, 'README.md'), '# r\n', 'utf-8');
    git(repo, ['add', '.']);
    git(repo, ['commit', '-q', '-m', 'init']);
    await writeFile(
      resolve(home, 'config.md'),
      `---\nversion: "2.0"\ndefaultProjectDir: ${resolve(home, 'projects')}\n---\n`,
      'utf-8',
    );
    await mkdir(resolve(home, 'projects', 'p', 'assignments'), { recursive: true });
    await writeFile(resolve(home, 'projects', 'p', 'project.md'), '---\nslug: p\ntitle: "P"\n---\n# P\n', 'utf-8');
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('prints the worktree path for an existing worktree', async () => {
    const wt = resolve(repo, '.worktrees', 'feat-x');
    git(repo, ['worktree', 'add', '-b', 'feat-x', wt, 'main']);
    await writeAssignment('a', wt, 'feat-x');

    const r = await runCli(['open', 'a', '--project', 'p'], home);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain(wt);
  });

  it('resolves by --id and ignores --project', async () => {
    const wt = resolve(repo, '.worktrees', 'feat-x');
    git(repo, ['worktree', 'add', '-b', 'feat-x', wt, 'main']);
    await writeAssignment('a', wt, 'feat-x'); // frontmatter id: id-a
    const r = await runCli(['open', '--id', 'id-a', '--project', 'nonexistent'], home);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain(wt);
  });

  it('errors when no worktree is recorded', async () => {
    await writeAssignment('a', null, null);
    const r = await runCli(['open', 'a', '--project', 'p'], home);
    expect(r.code).not.toBe(0);
    expect(r.stderr.toLowerCase()).toContain('no worktree');
  });

  it('errors with a recreate hint when the dir is missing and --recreate is not passed (non-TTY)', async () => {
    const wt = resolve(repo, '.worktrees', 'feat-x');
    git(repo, ['worktree', 'add', '-b', 'feat-x', wt, 'main']);
    await writeAssignment('a', wt, 'feat-x');
    // Simulate a gc'd worktree: remove the dir but keep the branch + the record.
    git(repo, ['worktree', 'remove', wt]);
    expect(await fileExists(wt)).toBe(false);

    const r = await runCli(['open', 'a', '--project', 'p'], home);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain('recreate');
  });

  it('--recreate rebuilds a missing worktree at the recorded path', async () => {
    const wt = resolve(repo, '.worktrees', 'feat-x');
    git(repo, ['worktree', 'add', '-b', 'feat-x', wt, 'main']);
    await writeAssignment('a', wt, 'feat-x');
    git(repo, ['worktree', 'remove', wt]);
    expect(await fileExists(wt)).toBe(false);

    const r = await runCli(['open', 'a', '--project', 'p', '--recreate'], home);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain(wt);
    expect(await fileExists(wt)).toBe(true);
  });
});
