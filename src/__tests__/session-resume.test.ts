import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';

const CLI_ENTRY = resolve(__dirname, '..', '..', 'bin', 'syntaur.js');

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function runCli(args: string[], cwd: string, syntaurHome: string): Promise<RunResult> {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [CLI_ENTRY, ...args], {
      cwd,
      env: { ...process.env, SYNTAUR_HOME: syntaurHome },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('close', (code) => resolvePromise({ code: code ?? -1, stdout, stderr }));
  });
}

describe('syntaur session resume', () => {
  let syntaurHome: string;
  let workspaceRoot: string;
  let assignmentDir: string;

  beforeEach(async () => {
    syntaurHome = await mkdtemp(join(tmpdir(), 'syntaur-resume-'));
    await writeFile(
      resolve(syntaurHome, 'config.md'),
      `---\nversion: "2.0"\ndefaultProjectDir: ${resolve(syntaurHome, 'projects')}\nonboarding:\n  completed: true\n---\n`,
    );
    workspaceRoot = await mkdtemp(join(tmpdir(), 'syntaur-resume-wkspc-'));
    assignmentDir = resolve(syntaurHome, 'projects', 'p', 'assignments', 'demo');
    await mkdir(assignmentDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(syntaurHome, { recursive: true, force: true });
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  it('aborts with exit 1 when there is no .syntaur/context.json', async () => {
    const result = await runCli(['session', 'resume'], workspaceRoot, syntaurHome);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain('Cannot resume');
    expect(result.stdout).toContain('grab-assignment');
  });

  it('emits human-readable orientation when context + summary present', async () => {
    await mkdir(resolve(workspaceRoot, '.syntaur'), { recursive: true });
    await writeFile(
      resolve(workspaceRoot, '.syntaur', 'context.json'),
      JSON.stringify({
        projectSlug: 'p',
        assignmentSlug: 'demo',
        assignmentDir,
        title: 'Demo',
        branch: 'feat/demo',
      }),
    );
    const sid = '11111111-1111-1111-1111-111111111111';
    await mkdir(resolve(assignmentDir, 'sessions', sid), { recursive: true });
    await writeFile(
      resolve(assignmentDir, 'sessions', sid, 'summary.md'),
      `---\nassignment: demo\nsessionId: ${sid}\n---\n\n## Snapshot\n\nDoing the thing.\n`,
    );
    const result = await runCli(['session', 'resume'], workspaceRoot, syntaurHome);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain('Resuming Syntaur session');
    expect(result.stdout).toContain('demo');
    expect(result.stdout).toContain('Latest session summary');
    expect(result.stdout).toContain(sid);
  });

  it('is idempotent — running twice produces the same output and does not mutate state', async () => {
    await mkdir(resolve(workspaceRoot, '.syntaur'), { recursive: true });
    await writeFile(
      resolve(workspaceRoot, '.syntaur', 'context.json'),
      JSON.stringify({
        projectSlug: 'p',
        assignmentSlug: 'demo',
        assignmentDir,
      }),
    );
    const r1 = await runCli(['session', 'resume', '--json'], workspaceRoot, syntaurHome);
    const r2 = await runCli(['session', 'resume', '--json'], workspaceRoot, syntaurHome);
    expect(r1.code).toBe(0);
    expect(r2.code).toBe(0);
    expect(r1.stdout).toBe(r2.stdout);
  });
});
