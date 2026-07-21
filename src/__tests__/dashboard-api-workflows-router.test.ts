import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createWorkflowConfigRouter } from '../dashboard/api-status-config.js';
import { clearStatusConfigCache, getStatusConfig } from '../dashboard/api.js';
import { invalidateWorkflowLibraryCache } from '../utils/workflow-library.js';

const originalHome = process.env.HOME;
const originalSyntaurHome = process.env.SYNTAUR_HOME;

let tmpHome: string;
let projectsDir: string;
let standaloneDir: string;
let server: Server;
let baseUrl: string;

async function seedAssignment(slug: string, workflow: string | null): Promise<void> {
  const dir = join(projectsDir, 'p1', 'assignments', slug);
  await mkdir(dir, { recursive: true });
  const wf = workflow ? `\nworkflow: ${workflow}` : '';
  await writeFile(
    join(dir, 'assignment.md'),
    `---\nid: 33333333-3333-3333-3333-${slug.padEnd(12, '0').slice(0, 12)}\nslug: ${slug}\ntitle: ${slug}\nproject: p1\nstatus: in_progress\npriority: medium${wf}\n---\n\n# ${slug}\n`,
  );
}

function get(path = ''): Promise<Response> {
  return fetch(`${baseUrl}${path}`);
}
function post(path: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}
function del(path: string): Promise<Response> {
  return fetch(`${baseUrl}${path}`, { method: 'DELETE' });
}

beforeEach(async () => {
  tmpHome = await mkdtemp(join(tmpdir(), 'syntaur-wf-router-'));
  await mkdir(join(tmpHome, '.syntaur'), { recursive: true });
  projectsDir = join(tmpHome, 'projects');
  standaloneDir = join(tmpHome, '.syntaur', 'assignments');
  await mkdir(projectsDir, { recursive: true });
  await mkdir(standaloneDir, { recursive: true });
  process.env.HOME = tmpHome;
  process.env.SYNTAUR_HOME = join(tmpHome, '.syntaur');
  clearStatusConfigCache();

  const app = express();
  app.use(express.json());
  app.use('/api/config/workflows', createWorkflowConfigRouter(projectsDir, standaloneDir));
  await new Promise<void>((ready) => {
    server = app.listen(0, () => ready());
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/config/workflows`;
});

afterEach(async () => {
  await new Promise<void>((done) => server.close(() => done()));
  process.env.HOME = originalHome;
  if (originalSyntaurHome === undefined) delete process.env.SYNTAUR_HOME;
  else process.env.SYNTAUR_HOME = originalSyntaurHome;
  await rm(tmpHome, { recursive: true, force: true });
  clearStatusConfigCache();
});

describe('workflow library routes', () => {
  it('lists just the synthesized default for a fresh config', async () => {
    const body = await (await get()).json();
    expect(body.defaultWorkflow).toBe('default');
    expect(body.workflows).toHaveLength(1);
    expect(body.workflows[0]).toMatchObject({ id: 'default', isDefault: true });
  });

  it('creates a workflow, then lists + reads it back', async () => {
    const created = await post('', { id: 'bug', label: 'Bug Flow' });
    expect(created.status).toBe(201);

    const list = await (await get()).json();
    const ids = list.workflows.map((w: { id: string }) => w.id).sort();
    expect(ids).toEqual(['bug', 'default']);
    expect(list.workflows.find((w: { id: string }) => w.id === 'bug').label).toBe('Bug Flow');

    const bug = await (await get('/bug')).json();
    expect(Array.isArray(bug.statuses)).toBe(true);
  });

  it('rejects a malformed id and a duplicate id', async () => {
    expect((await post('', { id: 'Bad Id!' })).status).toBe(400);
    expect((await post('', { id: 'default' })).status).toBe(409);
  });

  it('promotes a workflow to the global default', async () => {
    await post('', { id: 'bug' });
    const res = await post('/bug/default', {});
    expect(res.status).toBe(200);
    expect((await res.json()).defaultWorkflow).toBe('bug');
    const list = await (await get()).json();
    expect(list.workflows.find((w: { id: string }) => w.id === 'bug').isDefault).toBe(true);
  });

  it('duplicates a workflow into a new id', async () => {
    await post('', { id: 'bug', label: 'Bug' });
    const dup = await post('/bug/duplicate', { id: 'bug2', label: 'Bug Copy' });
    expect(dup.status).toBe(201);
    const list = await (await get()).json();
    expect(list.workflows.map((w: { id: string }) => w.id).sort()).toEqual([
      'bug',
      'bug2',
      'default',
    ]);
  });

  it('blocks deletion while a ticket resolves to the workflow, then allows it once clear', async () => {
    await post('', { id: 'bug' });
    await seedAssignment('a1', 'bug');

    const blocked = await del('/bug');
    expect(blocked.status).toBe(409);
    const blockedBody = await blocked.json();
    expect(blockedBody.error).toBe('workflow-in-use');
    expect(blockedBody.assignmentCount).toBe(1);

    // Remove the ticket → deletion succeeds.
    await rm(join(projectsDir, 'p1', 'assignments', 'a1'), { recursive: true, force: true });
    const ok = await del('/bug');
    expect(ok.status).toBe(200);
    expect((await ok.json()).deleted).toBe(true);

    const list = await (await get()).json();
    expect(list.workflows.map((w: { id: string }) => w.id)).toEqual(['default']);
  });

  it('DELETE of the built-in default resets rather than removing it', async () => {
    const res = await del('/default');
    expect(res.status).toBe(200);
    const body = await res.json();
    // Reset returns the (built-in) status config, not { deleted: true }.
    expect(Array.isArray(body.statuses)).toBe(true);
    const list = await (await get()).json();
    expect(list.workflows.some((w: { id: string }) => w.id === 'default')).toBe(true);
  });
});

// ── WS-3 (T8 + T9b): the post-migration settings surface ─────────────────────
describe('post-migration workflow routes (WS-3)', () => {
  async function migrateFixture(): Promise<void> {
    const { markStagesMigrated } = await import('../lifecycle/recompute.js');
    const { invalidateWorkflowLibraryCache } = await import('../utils/workflow-library.js');
    const root = process.env.SYNTAUR_HOME!;
    await mkdir(join(root, 'workflows'), { recursive: true });
    await writeFile(
      join(root, 'workflows', 'default.md'),
      'id: default\nstages:\n  - id: draft\n    next: [{ to: done, on: manual }]\n  - id: done\n    terminal: true\n',
      'utf-8',
    );
    await writeFile(
      join(root, 'workflows', 'test.md'),
      'id: test\nlabel: test\nstages:\n  - id: pending\n  - id: done\n    terminal: true\n',
      'utf-8',
    );
    await markStagesMigrated();
    invalidateWorkflowLibraryCache();
    clearStatusConfigCache();
  }

  it('T8: GET lists the PER-FILE library once migrated (metadata non-empty, incl. test)', async () => {
    await migrateFixture();
    const body = await (await get()).json();
    expect(body.workflows.map((w: { id: string }) => w.id).sort()).toEqual(['default', 'test']);
    expect(body.workflows.find((w: { id: string }) => w.id === 'test').label).toBe('test');
    expect(body.workflows.find((w: { id: string }) => w.id === 'default').isDefault).toBe(true);
  });

  it('T9b: create / promote-default / duplicate hard-refuse with 409 workflows-migrated', async () => {
    await migrateFixture();
    const create = await post('', { id: 'newflow' });
    expect(create.status).toBe(409);
    expect((await create.json()).error).toBe('workflows-migrated');

    const promote = await post('/default/default', {});
    expect(promote.status).toBe(409);
    expect((await promote.json()).error).toBe('workflows-migrated');

    const dup = await post('/default/duplicate', { id: 'copyflow' });
    expect(dup.status).toBe(409);
    expect((await dup.json()).error).toBe('workflows-migrated');

    // No route recreated a config block — the per-file loader stays healthy.
    const { loadWorkflowLibrary } = await import('../utils/workflow-library.js');
    invalidateWorkflowLibraryCache();
    expect(() => loadWorkflowLibrary({ workflows: null, statuses: null })).not.toThrow();
  });
});

describe('getStatusConfig — per-file StageWorkflow fallback (post-migration)', () => {
  it('resolves a per-file workflow (no config block) to ITS stages, not built-in defaults (codex code-r1)', async () => {
    const wfDir = join(tmpHome, '.syntaur', 'workflows');
    await mkdir(wfDir, { recursive: true });
    await writeFile(
      join(wfDir, 'test.md'),
      'id: test\nlabel: Test\nstages:\n  - id: pending\n  - id: in_progress\n  - id: completed\n    terminal: true\n  - id: failed\n    terminal: true\n',
    );
    invalidateWorkflowLibraryCache();
    clearStatusConfigCache();

    const cfg = await getStatusConfig('test');
    expect(cfg.statuses.map((s) => s.id)).toEqual(['pending', 'in_progress', 'completed', 'failed']);
    expect([...cfg.terminalStatuses].sort()).toEqual(['completed', 'failed']);
    expect(cfg.label).toBe('Test');
    // Engine-owned workflow: NO legacy transition affordances synthesized —
    // an empty table means the board can't offer default lifecycle commands.
    expect(cfg.transitions).toEqual([]);
    expect(cfg.transitionTable.size).toBe(0);
    expect(cfg.custom).toBe(true);
  });
});
