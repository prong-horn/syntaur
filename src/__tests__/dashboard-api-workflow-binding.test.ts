import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createWriteRouter } from '../dashboard/api-write.js';
import { clearStatusConfigCache } from '../dashboard/api.js';
import { writeWorkflowsConfig, type WorkflowDefinition } from '../utils/config.js';
import { buildDefaultStatusConfig } from '../utils/status-defaults.js';

const originalHome = process.env.HOME;
const originalSyntaurHome = process.env.SYNTAUR_HOME;

let tmpHome: string;
let projectsDir: string;
let server: Server;
let base: string;

async function seedProject(slug: string): Promise<void> {
  const dir = join(projectsDir, slug);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'project.md'),
    `---\nid: ${slug}\nslug: ${slug}\ntitle: ${slug}\n---\n# ${slug}\n`,
  );
}

async function seedAssignment(project: string, slug: string): Promise<string> {
  const dir = join(projectsDir, project, 'assignments', slug);
  await mkdir(dir, { recursive: true });
  const path = join(dir, 'assignment.md');
  await writeFile(
    path,
    `---\nid: 55555555-5555-5555-5555-${slug.padEnd(12, '0').slice(0, 12)}\nslug: ${slug}\ntitle: ${slug}\nproject: ${project}\ntype: feature\nstatus: in_progress\npriority: medium\n---\n# ${slug}\n`,
  );
  return path;
}

function put(path: string, body: unknown): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(async () => {
  tmpHome = await mkdtemp(join(tmpdir(), 'syntaur-wf-bind-'));
  await mkdir(join(tmpHome, '.syntaur'), { recursive: true });
  projectsDir = join(tmpHome, 'projects');
  await mkdir(projectsDir, { recursive: true });
  await mkdir(join(tmpHome, '.syntaur', 'assignments'), { recursive: true });
  process.env.HOME = tmpHome;
  process.env.SYNTAUR_HOME = join(tmpHome, '.syntaur');

  const def: WorkflowDefinition = { label: 'Default', ...buildDefaultStatusConfig() };
  const bug: WorkflowDefinition = { label: 'Bug', ...buildDefaultStatusConfig() };
  await writeWorkflowsConfig({ default: def, bug }, 'default');
  clearStatusConfigCache();

  const app = express();
  app.use(express.json());
  app.use(createWriteRouter(projectsDir, join(tmpHome, '.syntaur', 'assignments'), undefined));
  await new Promise<void>((ready) => {
    server = app.listen(0, () => ready());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((done) => server.close(() => done()));
  process.env.HOME = originalHome;
  if (originalSyntaurHome === undefined) delete process.env.SYNTAUR_HOME;
  else process.env.SYNTAUR_HOME = originalSyntaurHome;
  await rm(tmpHome, { recursive: true, force: true });
  clearStatusConfigCache();
});

describe('project workflow-binding route', () => {
  it('writes defaultWorkflow + workflowByType to project.md', async () => {
    await seedProject('p');
    const res = await put('/api/projects/p/workflow-binding', {
      defaultWorkflow: 'bug',
      workflowByType: { bug: 'bug', chore: 'default' },
    });
    expect(res.status).toBe(200);
    const md = await readFile(join(projectsDir, 'p', 'project.md'), 'utf-8');
    expect(md).toMatch(/^defaultWorkflow: bug$/m);
    expect(md).toMatch(/workflowByType:\n\s+bug: bug\n\s+chore: default/);
  });

  it('rejects an unknown workflow', async () => {
    await seedProject('p');
    expect((await put('/api/projects/p/workflow-binding', { defaultWorkflow: 'ghost' })).status).toBe(400);
    expect(
      (await put('/api/projects/p/workflow-binding', { workflowByType: { bug: 'ghost' } })).status,
    ).toBe(400);
  });

  it('clears the binding when given empty values', async () => {
    await seedProject('p');
    await put('/api/projects/p/workflow-binding', { defaultWorkflow: 'bug' });
    await put('/api/projects/p/workflow-binding', { defaultWorkflow: null, workflowByType: {} });
    const md = await readFile(join(projectsDir, 'p', 'project.md'), 'utf-8');
    expect(md).not.toMatch(/^defaultWorkflow:/m);
    expect(md).not.toMatch(/^workflowByType:/m);
  });
});

describe('assignment workflow route', () => {
  it('sets the workflow override and re-derives', async () => {
    await seedProject('p');
    await seedAssignment('p', 'a1');
    const res = await put('/api/projects/p/assignments/a1/workflow', { workflow: 'bug' });
    expect(res.status).toBe(200);
    const md = await readFile(join(projectsDir, 'p', 'assignments', 'a1', 'assignment.md'), 'utf-8');
    expect(md).toMatch(/^workflow: bug$/m);
  });

  it('rejects an unknown workflow', async () => {
    await seedProject('p');
    await seedAssignment('p', 'a1');
    expect(
      (await put('/api/projects/p/assignments/a1/workflow', { workflow: 'ghost' })).status,
    ).toBe(400);
  });

  it('clears the workflow override when given null', async () => {
    await seedProject('p');
    await seedAssignment('p', 'a1');
    await put('/api/projects/p/assignments/a1/workflow', { workflow: 'bug' });
    await put('/api/projects/p/assignments/a1/workflow', { workflow: null });
    const md = await readFile(join(projectsDir, 'p', 'assignments', 'a1', 'assignment.md'), 'utf-8');
    expect(md).not.toMatch(/^workflow:/m);
  });
});
