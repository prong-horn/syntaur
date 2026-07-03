import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';

const CLI_ENTRY = resolve(__dirname, '..', '..', 'bin', 'syntaur.js');

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function runCli(args: string[], home: string): Promise<RunResult> {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [CLI_ENTRY, ...args], {
      env: { ...process.env, SYNTAUR_HOME: home },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('close', (code) => resolvePromise({ code: code ?? -1, stdout, stderr }));
  });
}

describe('syntaur workflow', () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'syntaur-wf-cmd-'));
    await writeFile(
      resolve(home, 'config.md'),
      `---\nversion: "2.0"\ndefaultProjectDir: ${resolve(home, 'projects')}\n---\n`,
      'utf-8',
    );
    await mkdir(resolve(home, 'projects'), { recursive: true });
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  async function seedProject(slug: string): Promise<void> {
    const dir = resolve(home, 'projects', slug);
    await mkdir(dir, { recursive: true });
    await writeFile(
      resolve(dir, 'project.md'),
      `---\nid: ${slug}\nslug: ${slug}\ntitle: ${slug}\n---\n# ${slug}\n`,
      'utf-8',
    );
  }

  async function seedAssignment(project: string, slug: string, workflow: string): Promise<string> {
    const dir = resolve(home, 'projects', project, 'assignments', slug);
    await mkdir(dir, { recursive: true });
    const path = resolve(dir, 'assignment.md');
    await writeFile(
      path,
      `---\nid: 4444-${slug}\nslug: ${slug}\ntitle: ${slug}\nproject: ${project}\nstatus: in_progress\nworkflow: ${workflow}\n---\n# ${slug}\n`,
      'utf-8',
    );
    return path;
  }

  async function list(): Promise<{
    workflows: { id: string; label: string; isDefault: boolean }[];
    defaultWorkflow: string;
  }> {
    const res = await runCli(['workflow', 'list', '--json'], home);
    expect(res.code).toBe(0);
    return JSON.parse(res.stdout);
  }

  it('lists just the default for a fresh config', async () => {
    const out = await list();
    expect(out.defaultWorkflow).toBe('default');
    expect(out.workflows.map((w) => w.id)).toEqual(['default']);
  });

  it('creates, clones, and lists workflows', async () => {
    expect((await runCli(['workflow', 'new', 'bug', '--label', 'Bug Flow'], home)).code).toBe(0);
    expect((await runCli(['workflow', 'new', 'bug2', '--from', 'bug'], home)).code).toBe(0);
    const out = await list();
    expect(out.workflows.map((w) => w.id).sort()).toEqual(['bug', 'bug2', 'default']);
    expect(out.workflows.find((w) => w.id === 'bug')!.label).toBe('Bug Flow');
  });

  it('rejects a duplicate id and an invalid id', async () => {
    expect((await runCli(['workflow', 'new', 'default'], home)).code).toBe(1);
    expect((await runCli(['workflow', 'new', 'Bad Id!'], home)).code).toBe(1);
  });

  it('sets the global default workflow', async () => {
    await runCli(['workflow', 'new', 'bug'], home);
    expect((await runCli(['workflow', 'set-default', 'bug'], home)).code).toBe(0);
    const out = await list();
    expect(out.defaultWorkflow).toBe('bug');
    expect(out.workflows.find((w) => w.id === 'bug')!.isDefault).toBe(true);
  });

  it('binds a project type to a workflow', async () => {
    await seedProject('p');
    await runCli(['workflow', 'new', 'bug'], home);
    const res = await runCli(['workflow', 'bind-type', 'p', 'bug', 'bug'], home);
    expect(res.code).toBe(0);
    const projectMd = await readFile(resolve(home, 'projects', 'p', 'project.md'), 'utf-8');
    expect(projectMd).toMatch(/workflowByType:\n\s+bug: bug/);
  });

  it('blocks delete while a ticket resolves to the workflow, then allows it', async () => {
    await seedProject('p');
    await runCli(['workflow', 'new', 'bug'], home);
    await seedAssignment('p', 'a1', 'bug');

    const blocked = await runCli(['workflow', 'delete', 'bug'], home);
    expect(blocked.code).toBe(1);
    expect(blocked.stderr).toMatch(/reassign|resolve to it/);

    await rm(resolve(home, 'projects', 'p', 'assignments', 'a1'), { recursive: true, force: true });
    expect((await runCli(['workflow', 'delete', 'bug'], home)).code).toBe(0);
    expect((await list()).workflows.map((w) => w.id)).toEqual(['default']);
  });

  it('never deletes the built-in default', async () => {
    const res = await runCli(['workflow', 'delete', 'default'], home);
    expect(res.code).toBe(1);
    expect(res.stderr).toMatch(/cannot be deleted/);
  });

  it('create-assignment --workflow writes the workflow field', async () => {
    await seedProject('p');
    await runCli(['workflow', 'new', 'bug'], home);
    const res = await runCli(
      ['create-assignment', 'Fix the thing', '--project', 'p', '--workflow', 'bug'],
      home,
    );
    expect(res.code).toBe(0);
    // Find the created assignment.md and assert its workflow field.
    const assignmentsRoot = resolve(home, 'projects', 'p', 'assignments');
    const { readdir } = await import('node:fs/promises');
    const slugs = await readdir(assignmentsRoot);
    const md = await readFile(resolve(assignmentsRoot, slugs[0], 'assignment.md'), 'utf-8');
    expect(md).toMatch(/^workflow: bug$/m);
  });
});
