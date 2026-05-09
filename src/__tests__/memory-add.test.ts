import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';

const CLI_ENTRY = resolve(__dirname, '..', '..', 'bin', 'syntaur.js');

interface RunResult { code: number; stdout: string; stderr: string }

async function runCli(args: string[], syntaurHome: string): Promise<RunResult> {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [CLI_ENTRY, ...args], {
      env: { ...process.env, SYNTAUR_HOME: syntaurHome },
    });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('close', (code) => resolvePromise({ code: code ?? -1, stdout, stderr }));
  });
}

describe('syntaur memory add', () => {
  let syntaurHome: string;
  let projectDir: string;

  beforeEach(async () => {
    syntaurHome = await mkdtemp(join(tmpdir(), 'syntaur-madd-'));
    const projectsDir = resolve(syntaurHome, 'projects');
    await mkdir(projectsDir, { recursive: true });
    await writeFile(
      resolve(syntaurHome, 'config.md'),
      `---\nversion: "2.0"\ndefaultProjectDir: ${projectsDir}\nonboarding:\n  completed: true\n---\n`,
    );
    projectDir = resolve(projectsDir, 'p');
    await mkdir(projectDir, { recursive: true });
    await writeFile(resolve(projectDir, 'project.md'), '---\nslug: p\ntitle: P\n---\n');
  });

  afterEach(async () => {
    await rm(syntaurHome, { recursive: true, force: true });
  });

  it('writes <projectDir>/memories/<slug>.md and regenerates _index.md', async () => {
    const result = await runCli(
      [
        'memory', 'add',
        '--project', 'p',
        '--name', 'Worktree convention',
        '--source', 'conversation 2026-05-08',
        '--scope', 'project',
        '--source-assignment', 'ship-skills',
        '--related-assignments', 'a,b',
      ],
      syntaurHome,
    );
    expect(result.code, result.stderr).toBe(0);

    const slugFile = resolve(projectDir, 'memories', 'worktree-convention.md');
    const indexFile = resolve(projectDir, 'memories', '_index.md');
    const slugContent = await readFile(slugFile, 'utf-8');
    expect(slugContent).toContain('name: "Worktree convention"');
    expect(slugContent).toContain('source: "conversation 2026-05-08"');
    expect(slugContent).toContain('scope: "project"');
    expect(slugContent).toContain('sourceAssignment: "ship-skills"');

    const indexContent = await readFile(indexFile, 'utf-8');
    expect(indexContent).toContain('total: 1');
    expect(indexContent).toContain('| [Worktree convention](./worktree-convention.md) |');
  });

  it('refuses to overwrite without --force', async () => {
    await runCli(['memory', 'add', '--project', 'p', '--name', 'Mem', '--source', 'x'], syntaurHome);
    const r = await runCli(['memory', 'add', '--project', 'p', '--name', 'Mem', '--source', 'x'], syntaurHome);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('already exists');
  });
});
