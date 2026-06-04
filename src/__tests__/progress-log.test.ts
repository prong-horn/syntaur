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

const PROGRESS = `---
assignment: a
entryCount: 0
generated: "2026-01-01T00:00:00Z"
updated: "2026-01-01T00:00:00Z"
---

# Progress

No progress yet.
`;

describe('syntaur progress log', () => {
  let home: string;
  let progressPath: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'syntaur-prog-'));
    const dir = resolve(home, 'projects', 'p', 'assignments', 'a');
    await mkdir(dir, { recursive: true });
    await writeFile(resolve(dir, 'assignment.md'), '---\nid: x\nslug: a\nstatus: in_progress\n---\n# A\n', 'utf-8');
    progressPath = resolve(dir, 'progress.md');
    await writeFile(progressPath, PROGRESS, 'utf-8');
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('replaces the placeholder, increments entryCount, preserves assignment/generated', async () => {
    const r = await runCli(['progress', 'log', 'First entry', '--assignment', 'a', '--project', 'p'], home);
    expect(r.code, r.stderr).toBe(0);
    const content = await readFile(progressPath, 'utf-8');
    expect(content).not.toContain('No progress yet.');
    expect(content).toContain('First entry');
    expect(content).toContain('entryCount: 1');
    expect(content).toContain('assignment: a'); // preserved
    expect(content).toContain('generated: "2026-01-01T00:00:00Z"'); // preserved
    expect(content).not.toContain('updated: "2026-01-01T00:00:00Z"'); // bumped
  });

  it('keeps entries reverse-chronological (newest right after the H1)', async () => {
    await runCli(['progress', 'log', 'OLDER', '--assignment', 'a', '--project', 'p'], home);
    await runCli(['progress', 'log', 'NEWER', '--assignment', 'a', '--project', 'p'], home);
    const content = await readFile(progressPath, 'utf-8');
    expect(content).toContain('entryCount: 2');
    const h1 = content.indexOf('# Progress');
    expect(content.indexOf('NEWER')).toBeGreaterThan(h1);
    expect(content.indexOf('NEWER')).toBeLessThan(content.indexOf('OLDER'));
  });
});
