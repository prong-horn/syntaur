import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, readFile, writeFile, stat } from 'node:fs/promises';
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

describe('syntaur resource add', () => {
  let syntaurHome: string;
  let projectDir: string;

  beforeEach(async () => {
    syntaurHome = await mkdtemp(join(tmpdir(), 'syntaur-radd-'));
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

  it('writes <projectDir>/resources/<slug>.md and regenerates _index.md', async () => {
    const result = await runCli(
      [
        'resource', 'add',
        '--project', 'p',
        '--name', 'Grafana API Latency',
        '--source', 'https://grafana.example/d/api-latency',
        '--category', 'dashboard',
        '--related-assignments', 'foo,bar',
      ],
      syntaurHome,
    );
    expect(result.code, result.stderr).toBe(0);

    const slugFile = resolve(projectDir, 'resources', 'grafana-api-latency.md');
    const indexFile = resolve(projectDir, 'resources', '_index.md');
    const slugContent = await readFile(slugFile, 'utf-8');
    expect(slugContent).toContain('name: "Grafana API Latency"');
    expect(slugContent).toContain('category: "dashboard"');
    expect(slugContent).toContain('source: "https://grafana.example/d/api-latency"');
    expect(slugContent).toContain('relatedAssignments:');
    expect(slugContent).toMatch(/- foo[\s\S]*- bar/);

    const indexContent = await readFile(indexFile, 'utf-8');
    expect(indexContent).toContain('total: 1');
    expect(indexContent).toContain('| [Grafana API Latency](./grafana-api-latency.md) |');
  });

  it('escapes embedded double quotes in name/source/category', async () => {
    const result = await runCli(
      [
        'resource', 'add',
        '--project', 'p',
        '--name', 'Has "Quotes" In Name',
        '--source', 'note: includes a "quoted" word',
        '--category', 'misc "tag"',
        '--slug', 'quote-test',
      ],
      syntaurHome,
    );
    expect(result.code, result.stderr).toBe(0);
    const slugFile = resolve(projectDir, 'resources', 'quote-test.md');
    const slugContent = await readFile(slugFile, 'utf-8');
    expect(slugContent).toContain('name: "Has \\"Quotes\\" In Name"');
    expect(slugContent).toContain('source: "note: includes a \\"quoted\\" word"');
    expect(slugContent).toContain('category: "misc \\"tag\\""');
  });

  it('refuses to overwrite without --force', async () => {
    await runCli(['resource', 'add', '--project', 'p', '--name', 'Same', '--source', 's'], syntaurHome);
    const r = await runCli(['resource', 'add', '--project', 'p', '--name', 'Same', '--source', 's'], syntaurHome);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('already exists');
  });
});
