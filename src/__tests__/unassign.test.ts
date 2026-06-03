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

describe('syntaur unassign', () => {
  let home: string;
  let assignmentPath: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'syntaur-unassign-'));
    await writeFile(
      resolve(home, 'config.md'),
      `---\nversion: "2.0"\ndefaultProjectDir: ${resolve(home, 'projects')}\n---\n`,
      'utf-8',
    );
    const dir = resolve(home, 'projects', 'p', 'assignments', 'a');
    await mkdir(dir, { recursive: true });
    await writeFile(resolve(home, 'projects', 'p', 'project.md'), '---\nslug: p\ntitle: "P"\n---\n# P\n', 'utf-8');
    assignmentPath = resolve(dir, 'assignment.md');
    await writeFile(
      assignmentPath,
      '---\nid: x\nslug: a\ntitle: "A"\nstatus: in_progress\nassignee: claude\ncreated: "2026-01-01T00:00:00Z"\nupdated: "2026-01-01T00:00:00Z"\n---\n# A\n',
      'utf-8',
    );
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('clears the assignee to null and bumps updated', async () => {
    const r = await runCli(['unassign', 'a', '--project', 'p'], home);
    expect(r.code, r.stderr).toBe(0);
    const content = await readFile(assignmentPath, 'utf-8');
    expect(content).toContain('assignee: null');
    expect(content).not.toContain('assignee: claude');
    expect(content).not.toContain('updated: "2026-01-01T00:00:00Z"');
  });
});
