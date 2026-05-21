import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { createSavedViewsRouter, createDashboardLayoutRouter } from '../dashboard/api-saved-views.js';
import {
  createSavedView,
  deleteSavedView,
  readSavedViewsFile,
  resetSavedViewsFile,
  setDashboardLayout,
  updateSavedView,
  writeSavedViewsFile,
} from '../utils/saved-views.js';
import {
  DEFAULT_SAVED_VIEWS_FILE,
  type SavedViewConfig,
  type SavedViewsFile,
} from '../utils/saved-views-schema.js';

const SAMPLE_CONFIG: SavedViewConfig = {
  viewMode: 'list',
  filters: { status: 'all', priority: 'all', assignee: 'all', project: 'all', activity: 'all' },
  sortField: 'updated',
  sortDirection: 'desc',
  listSectionVisibility: { collapsed: [] },
  kanbanColumnVisibility: { hidden: [] },
  tableColumnVisibility: { hidden: [] },
};

describe('saved-views storage', () => {
  const originalHome = process.env.HOME;
  let homeDir: string;
  let viewsPath: string;

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'syntaur-saved-views-'));
    process.env.HOME = homeDir;
    await mkdir(resolve(homeDir, '.syntaur'), { recursive: true });
    viewsPath = resolve(homeDir, '.syntaur', 'saved-views.json');
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    await rm(homeDir, { recursive: true, force: true });
  });

  it('(a) returns defaults when the file is missing and does not persist them', async () => {
    const file = await readSavedViewsFile();
    expect(file).toEqual(DEFAULT_SAVED_VIEWS_FILE);
    const entries = await readdir(resolve(homeDir, '.syntaur'));
    expect(entries).not.toContain('saved-views.json');
  });

  it('(b) round-trips through write/read', async () => {
    const next: SavedViewsFile = JSON.parse(JSON.stringify(DEFAULT_SAVED_VIEWS_FILE));
    next.views[0] = { ...next.views[0], name: 'Renamed' };
    await writeSavedViewsFile(next);
    const read = await readSavedViewsFile();
    expect(read).toEqual(next);
  });

  it('(c) resets by removing the file', async () => {
    await writeSavedViewsFile(DEFAULT_SAVED_VIEWS_FILE);
    await resetSavedViewsFile();
    const entries = await readdir(resolve(homeDir, '.syntaur'));
    expect(entries).not.toContain('saved-views.json');
  });

  it('(d) backs up a corrupt file and returns defaults', async () => {
    await writeFile(viewsPath, '{ not valid json');
    const file = await readSavedViewsFile();
    expect(file).toEqual(DEFAULT_SAVED_VIEWS_FILE);
    const entries = await readdir(resolve(homeDir, '.syntaur'));
    expect(entries.filter((e) => e.startsWith('saved-views.corrupt-'))).toHaveLength(1);
    expect(entries).not.toContain('saved-views.json');
  });

  it('(e) backs up a shape-mismatched file and returns defaults', async () => {
    await writeFile(viewsPath, JSON.stringify({ version: 1, views: 'nope', dashboard: {} }));
    const file = await readSavedViewsFile();
    expect(file).toEqual(DEFAULT_SAVED_VIEWS_FILE);
    const entries = await readdir(resolve(homeDir, '.syntaur'));
    expect(entries.filter((e) => e.startsWith('saved-views.corrupt-'))).toHaveLength(1);
  });

  it('(f) returns defaults for unknown future version WITHOUT renaming the file', async () => {
    await writeFile(viewsPath, JSON.stringify({ version: 99, views: [], dashboard: { version: 1, slots: [] } }));
    const file = await readSavedViewsFile();
    expect(file).toEqual(DEFAULT_SAVED_VIEWS_FILE);
    const entries = await readdir(resolve(homeDir, '.syntaur'));
    expect(entries.filter((e) => e.startsWith('saved-views.corrupt-'))).toHaveLength(0);
    expect(entries).toContain('saved-views.json');
    const raw = await readFile(viewsPath, 'utf-8');
    expect(JSON.parse(raw).version).toBe(99);
  });
});

describe('saved-views CRUD helpers', () => {
  let file: SavedViewsFile;

  beforeEach(() => {
    file = JSON.parse(JSON.stringify(DEFAULT_SAVED_VIEWS_FILE));
  });

  it('createSavedView generates a UUID and appends', () => {
    const before = file.views.length;
    const { file: next, view } = createSavedView(file, {
      name: 'My View',
      workspace: null,
      config: SAMPLE_CONFIG,
    });
    expect(next.views).toHaveLength(before + 1);
    expect(view.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(view.name).toBe('My View');
    expect(view.workspace).toBe(null);
  });

  it('updateSavedView updates and bumps updatedAt; returns not-found for unknown id', () => {
    const target = file.views[0];
    const oldUpdated = target.updatedAt;
    const result = updateSavedView(file, target.id, { name: 'Renamed' }, () => '2030-01-01T00:00:00Z');
    expect('error' in result).toBe(false);
    if ('error' in result) return;
    expect(result.view.name).toBe('Renamed');
    expect(result.view.updatedAt).toBe('2030-01-01T00:00:00Z');
    expect(result.view.updatedAt).not.toBe(oldUpdated);

    const missing = updateSavedView(file, 'no-such-id', { name: 'x' });
    expect(missing).toEqual({ error: 'not-found' });
  });

  it('updateSavedView with workspace: null distinguishes explicit set from absent', () => {
    // Set workspace first
    const created = createSavedView(file, {
      name: 'WS View',
      workspace: 'foo',
      config: SAMPLE_CONFIG,
    });
    // Explicit null clears it
    const cleared = updateSavedView(created.file, created.view.id, { workspace: null });
    expect('error' in cleared).toBe(false);
    if ('error' in cleared) return;
    expect(cleared.view.workspace).toBe(null);

    // Absent workspace key preserves prior value
    const nameOnly = updateSavedView(cleared.file, created.view.id, { name: 'Renamed' });
    if ('error' in nameOnly) return;
    expect(nameOnly.view.workspace).toBe(null);
  });

  it('deleteSavedView cascades to nullify slots referencing the view', () => {
    const viewToDelete = file.views[0];
    const referencingSlot = file.dashboard.slots.find(
      (s) => s.widget?.kind === 'saved-view' && s.widget.viewId === viewToDelete.id,
    );
    expect(referencingSlot).toBeDefined();

    const result = deleteSavedView(file, viewToDelete.id);
    expect(result.deleted).toBe(true);
    expect(result.file.views.find((v) => v.id === viewToDelete.id)).toBeUndefined();
    const sameSlot = result.file.dashboard.slots.find((s) => s.id === referencingSlot!.id);
    expect(sameSlot?.widget).toBe(null);
  });

  it('deleteSavedView returns deleted:false for unknown id', () => {
    const result = deleteSavedView(file, 'no-such-id');
    expect(result.deleted).toBe(false);
    expect(result.file).toBe(file);
  });

  it('setDashboardLayout accepts known view ids', () => {
    const newSlots = [
      { id: 'slot-0', widget: { kind: 'saved-view' as const, viewId: file.views[0].id } },
      { id: 'slot-1', widget: null },
      { id: 'slot-2', widget: { kind: 'agent-sessions' as const } },
      { id: 'slot-3', widget: { kind: 'inventories' as const } },
      { id: 'slot-4', widget: null },
    ];
    const result = setDashboardLayout(file, newSlots);
    expect('error' in result).toBe(false);
    if ('error' in result) return;
    expect(result.file.dashboard.slots).toEqual(newSlots);
  });

  it('setDashboardLayout rejects an unknown view id with the offending id', () => {
    const newSlots = [
      { id: 'slot-0', widget: { kind: 'saved-view' as const, viewId: 'no-such-view' } },
    ];
    const result = setDashboardLayout(file, newSlots);
    expect(result).toEqual({ error: 'unknown-view-id', viewId: 'no-such-view' });
  });
});

describe('saved-views HTTP routes', () => {
  const originalHome = process.env.HOME;
  let homeDir: string;
  let server: Server;
  let port: number;

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'syntaur-saved-views-api-'));
    process.env.HOME = homeDir;
    await mkdir(resolve(homeDir, '.syntaur'), { recursive: true });

    const app = express();
    app.use(express.json());
    app.use('/api/saved-views', createSavedViewsRouter());
    app.use('/api/dashboard', createDashboardLayoutRouter());

    await new Promise<void>((ready) => {
      server = app.listen(0, () => ready());
    });
    port = (server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    await new Promise<void>((done) => server.close(() => done()));
    process.env.HOME = originalHome;
    await rm(homeDir, { recursive: true, force: true });
  });

  const base = () => `http://127.0.0.1:${port}`;

  it('GET /api/saved-views returns defaults on first read', async () => {
    const res = await fetch(`${base()}/api/saved-views`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual(DEFAULT_SAVED_VIEWS_FILE);
  });

  it('POST /api/saved-views returns 400 on missing name', async () => {
    const res = await fetch(`${base()}/api/saved-views`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspace: null, config: SAMPLE_CONFIG }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/name/);
  });

  it('POST /api/saved-views returns 201 with a new view appended', async () => {
    const res = await fetch(`${base()}/api/saved-views`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'API View', workspace: null, config: SAMPLE_CONFIG }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.views).toHaveLength(DEFAULT_SAVED_VIEWS_FILE.views.length + 1);
    expect(body.views.at(-1).name).toBe('API View');
  });

  it('PATCH /api/saved-views/:id returns 404 for unknown id', async () => {
    const res = await fetch(`${base()}/api/saved-views/no-such-id`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Renamed' }),
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe('view-not-found');
  });

  it('PATCH /api/saved-views/:id renames an existing view', async () => {
    const createRes = await fetch(`${base()}/api/saved-views`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'V1', workspace: null, config: SAMPLE_CONFIG }),
    });
    const created = await createRes.json();
    const id = created.views.at(-1).id;

    const patchRes = await fetch(`${base()}/api/saved-views/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'V1 Renamed' }),
    });
    expect(patchRes.status).toBe(200);
    const patched = await patchRes.json();
    expect(patched.views.find((v: { id: string }) => v.id === id).name).toBe('V1 Renamed');
  });

  it('DELETE /api/saved-views/:id removes view and cascades to nullify referencing slots', async () => {
    const createRes = await fetch(`${base()}/api/saved-views`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'To Delete', workspace: null, config: SAMPLE_CONFIG }),
    });
    const id = (await createRes.json()).views.at(-1).id;

    // Pin into slot-0
    const putRes = await fetch(`${base()}/api/dashboard`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        slots: [
          { id: 'slot-0', widget: { kind: 'saved-view', viewId: id } },
          { id: 'slot-1', widget: null },
          { id: 'slot-2', widget: null },
          { id: 'slot-3', widget: null },
          { id: 'slot-4', widget: null },
        ],
      }),
    });
    expect(putRes.status).toBe(200);

    const delRes = await fetch(`${base()}/api/saved-views/${id}`, { method: 'DELETE' });
    expect(delRes.status).toBe(200);
    const final = await delRes.json();
    expect(final.views.find((v: { id: string }) => v.id === id)).toBeUndefined();
    const slot0 = final.dashboard.slots.find((s: { id: string }) => s.id === 'slot-0');
    expect(slot0.widget).toBe(null);
  });

  it('PUT /api/dashboard returns 400 with the offending viewId for unknown ref', async () => {
    const res = await fetch(`${base()}/api/dashboard`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        slots: [{ id: 'slot-0', widget: { kind: 'saved-view', viewId: 'no-such-view' } }],
      }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toEqual({ error: 'unknown-view-id', viewId: 'no-such-view' });
  });

  it('PUT /api/dashboard accepts valid built-in widget slots', async () => {
    const slots = [
      { id: 'slot-0', widget: { kind: 'agent-sessions' } },
      { id: 'slot-1', widget: { kind: 'inventories' } },
      { id: 'slot-2', widget: null },
      { id: 'slot-3', widget: null },
      { id: 'slot-4', widget: null },
    ];
    const res = await fetch(`${base()}/api/dashboard`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slots }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.dashboard.slots).toEqual(slots);
  });
});

describe('saved-views DEFAULT_SAVED_VIEWS_FILE shape', () => {
  it('has version 1, three seeded views, and 5 slots referencing the seeds', () => {
    const file = DEFAULT_SAVED_VIEWS_FILE;
    expect(file.version).toBe(1);
    expect(file.views.map((v) => v.id)).toEqual([
      'default-recently-updated',
      'default-high-priority',
      'default-stale',
    ]);
    expect(file.dashboard.slots).toHaveLength(5);
    const viewIds = new Set(file.views.map((v) => v.id));
    for (const slot of file.dashboard.slots) {
      if (slot.widget?.kind === 'saved-view') {
        expect(viewIds.has(slot.widget.viewId)).toBe(true);
      }
    }
  });

  it('seeded views are status-agnostic (no hardcoded status ids)', () => {
    for (const view of DEFAULT_SAVED_VIEWS_FILE.views) {
      expect(view.config.filters.status).toBe('all');
    }
  });
});
