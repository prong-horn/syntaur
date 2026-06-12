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
  isDashboardSlot,
  isProjectDetailCompatible,
  isSavedView,
  isSavedViewConfig,
  isViewFilters,
  isWidgetConfig,
  isWidgetSize,
  WIDGET_SIZES,
  type DashboardSlot,
  type SavedViewConfig,
  type SavedViewsFile,
} from '../utils/saved-views-schema.js';
import { captureCurrentView, type CaptureInput } from '../utils/saved-view-builder.js';
import type { ViewFilters } from '../utils/view-prefs-schema.js';
// Dashboard create-view helper. savedViews.ts imports @shared only as
// `import type` (erased at runtime), so it loads under node with no alias —
// letting this integration test POST the exact payload the /views dialog builds.
import {
  buildCreateViewPayload,
  DEFAULT_CREATE_VIEW_STATE,
} from '../../dashboard/src/lib/savedViews';

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

  it('(b2) round-trips dashboard slot sizes through write/read, leaving size-less slots untouched', async () => {
    const next: SavedViewsFile = JSON.parse(JSON.stringify(DEFAULT_SAVED_VIEWS_FILE));
    next.dashboard.slots = [
      { id: 'slot-0', widget: { kind: 'agent-sessions' }, size: 'large' },
      { id: 'slot-1', widget: { kind: 'saved-view', viewId: next.views[0].id }, size: 'wide' },
      { id: 'slot-2', widget: null, size: 'tall' },
      { id: 'slot-3', widget: null }, // legacy size-less slot — must survive unchanged
    ];
    await writeSavedViewsFile(next);
    const read = await readSavedViewsFile();
    expect(read).toEqual(next);
    // No migration: the size-less slot is not given a `size` on read.
    expect(read.dashboard.slots[3]).not.toHaveProperty('size');
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

  it('isWidgetSize accepts the four tiers and rejects everything else', () => {
    expect(WIDGET_SIZES).toEqual(['small', 'wide', 'tall', 'large']);
    for (const s of WIDGET_SIZES) expect(isWidgetSize(s)).toBe(true);
    for (const bad of ['huge', '', 'SMALL', null, undefined, 0, {}, []]) {
      expect(isWidgetSize(bad)).toBe(false);
    }
  });

  it('isDashboardSlot validates the optional size on both filled and empty slots', () => {
    // Valid size on a filled slot, and on an empty slot.
    expect(isDashboardSlot({ id: 'slot-0', widget: { kind: 'agent-sessions' }, size: 'large' })).toBe(true);
    expect(isDashboardSlot({ id: 'slot-0', widget: null, size: 'wide' })).toBe(true);
    // Absent size is fine (backward compatibility).
    expect(isDashboardSlot({ id: 'slot-0', widget: null })).toBe(true);
    // Invalid size on a filled slot is rejected.
    expect(isDashboardSlot({ id: 'slot-0', widget: { kind: 'agent-sessions' }, size: 'huge' })).toBe(false);
    // Invalid size on an EMPTY slot is rejected too — regression guard: the size
    // check must run BEFORE the `widget === null` early return.
    expect(isDashboardSlot({ id: 'slot-0', widget: null, size: 'huge' })).toBe(false);
  });

  it('setDashboardLayout round-trips slot sizes and leaves size-less slots untouched', () => {
    const sized: DashboardSlot[] = [
      { id: 'slot-0', widget: { kind: 'agent-sessions' }, size: 'large' },
      { id: 'slot-1', widget: { kind: 'inventories' }, size: 'wide' },
      { id: 'slot-2', widget: null, size: 'tall' },
      { id: 'slot-3', widget: null }, // no size — back-compat
    ];
    const result = setDashboardLayout(file, sized);
    expect('error' in result).toBe(false);
    if ('error' in result) return;
    expect(result.file.dashboard.slots).toEqual(sized);
    expect(result.file.dashboard.slots[3]).not.toHaveProperty('size');
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

  it('POST /api/saved-views persists a builder-shaped global view with MULTI-value filters', async () => {
    const { workspace, config } = buildCreateViewPayload(
      {
        ...DEFAULT_CREATE_VIEW_STATE,
        filters: { priority: ['high', 'critical'], status: ['in_progress', 'review'], type: ['feature'] },
      },
      null,
    );
    const res = await fetch(`${base()}/api/saved-views`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Builder Global', workspace, config }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    const created = body.views.at(-1);
    expect(created.name).toBe('Builder Global');
    expect(created.workspace).toBe(null);
    expect(created.config.filters.priority).toEqual(['high', 'critical']);
    expect(created.config.filters.status).toEqual(['in_progress', 'review']);
    expect(created.config.filters.type).toEqual(['feature']);

    // A LEGACY single-string POST still validates + persists (back-compat).
    const legacy = await fetch(`${base()}/api/saved-views`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Legacy Scalar',
        workspace: null,
        config: { ...config, filters: { priority: 'high' } },
      }),
    });
    expect(legacy.status).toBe(201);

    // Persisted to disk and re-readable.
    const file = await readSavedViewsFile();
    expect(file.views.find((v) => v.id === created.id)?.workspace).toBe(null);
  });

  it('POST /api/saved-views persists a builder-shaped workspace-scoped view', async () => {
    const { workspace, config } = buildCreateViewPayload(DEFAULT_CREATE_VIEW_STATE, 'syntaur');
    const res = await fetch(`${base()}/api/saved-views`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Builder Scoped', workspace, config }),
    });
    expect(res.status).toBe(201);
    const created = (await res.json()).views.at(-1);
    expect(created.workspace).toBe('syntaur');

    const file = await readSavedViewsFile();
    expect(file.views.find((v) => v.id === created.id)?.workspace).toBe('syntaur');
  });

  it('POST /api/saved-views stores the _ungrouped workspace literally', async () => {
    const { workspace, config } = buildCreateViewPayload(DEFAULT_CREATE_VIEW_STATE, '_ungrouped');
    expect(workspace).toBe('_ungrouped');
    const res = await fetch(`${base()}/api/saved-views`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Ungrouped View', workspace, config }),
    });
    expect(res.status).toBe(201);
    const created = (await res.json()).views.at(-1);
    expect(created.workspace).toBe('_ungrouped');
  });

  it('POST + PATCH a view with dateRange / tags / search (create + edit round-trip)', async () => {
    const { config } = buildCreateViewPayload(
      {
        ...DEFAULT_CREATE_VIEW_STATE,
        filters: { tags: ['backend'], dateRange: { field: 'updated', preset: 'last_7d' }, search: 'login' },
      },
      null,
    );
    const res = await fetch(`${base()}/api/saved-views`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Recent backend', workspace: null, config }),
    });
    expect(res.status).toBe(201);
    const created = (await res.json()).views.at(-1);
    expect(created.config.filters.tags).toEqual(['backend']);
    expect(created.config.filters.dateRange).toEqual({ field: 'updated', preset: 'last_7d' });
    expect(created.config.filters.search).toBe('login');

    // Edit (PATCH config): change the date range to an absolute range.
    const edited = buildCreateViewPayload(
      { ...DEFAULT_CREATE_VIEW_STATE, filters: { tags: ['backend'], dateRange: { field: 'created', from: '2026-05-01', to: '2026-05-31' } } },
      null,
    ).config;
    const patch = await fetch(`${base()}/api/saved-views/${created.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ config: edited }),
    });
    expect(patch.status).toBe(200);
    const file = await readSavedViewsFile();
    const stored = file.views.find((v) => v.id === created.id);
    expect(stored?.config.filters.dateRange).toEqual({ field: 'created', from: '2026-05-01', to: '2026-05-31' });
    expect(stored?.config.filters.search).toBeUndefined(); // cleared on edit
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

  it('PUT /api/dashboard round-trips slot sizes (incl. a legacy size-less slot)', async () => {
    const slots = [
      { id: 'slot-0', widget: { kind: 'agent-sessions' }, size: 'large' },
      { id: 'slot-1', widget: { kind: 'inventories' }, size: 'wide' },
      { id: 'slot-2', widget: null, size: 'tall' },
      { id: 'slot-3', widget: null }, // legacy, no size
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
    expect(body.dashboard.slots[3]).not.toHaveProperty('size');
  });

  it('PUT /api/dashboard returns 400 for an invalid size on a filled slot', async () => {
    const res = await fetch(`${base()}/api/dashboard`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slots: [{ id: 'slot-0', widget: { kind: 'agent-sessions' }, size: 'huge' }] }),
    });
    expect(res.status).toBe(400);
  });

  it('PUT /api/dashboard returns 400 for an invalid size on an empty slot (early-return guard)', async () => {
    const res = await fetch(`${base()}/api/dashboard`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slots: [{ id: 'slot-0', widget: null, size: 'huge' }] }),
    });
    expect(res.status).toBe(400);
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

// ── AC4: the canonical `query` filter through schema + minimize + routing ─────
describe('AC4 — query filter schema, minimize, and ProjectDetail compatibility', () => {
  function minimize(filters: ViewFilters): ViewFilters {
    const input: CaptureInput = {
      name: 'X',
      context: { workspace: null, projectSlug: null },
      state: {
        viewMode: 'kanban',
        filters,
        sortField: 'updated',
        sortDirection: 'desc',
        listSectionVisibility: { collapsed: [] },
        kanbanColumnVisibility: { hidden: [] },
        tableColumnVisibility: { hidden: [] },
      },
    };
    return captureCurrentView(input).config.filters;
  }

  function configWith(filters: ViewFilters): SavedViewConfig {
    return {
      viewMode: 'kanban',
      filters,
      sortField: 'updated',
      sortDirection: 'desc',
      listSectionVisibility: { collapsed: [] },
      kanbanColumnVisibility: { hidden: [] },
      tableColumnVisibility: { hidden: [] },
    };
  }

  it('isViewFilters accepts a string query and rejects a non-string query', () => {
    expect(isViewFilters({ query: 'qaPassed:true' })).toBe(true);
    expect(isViewFilters({ query: 123 })).toBe(false);
    expect(isViewFilters({ query: ['x'] })).toBe(false);
    expect(isViewFilters({ query: null })).toBe(false);
  });

  it('minimizeFilters preserves, trims, and drops the query', () => {
    expect(minimize({ query: 'qaPassed:true' }).query).toBe('qaPassed:true');
    expect(minimize({ query: '   status:draft   ' }).query).toBe('status:draft');
    expect(minimize({ query: '' }).query).toBeUndefined();
    expect(minimize({ query: '   ' }).query).toBeUndefined();
    expect(minimize({}).query).toBeUndefined();
  });

  it('isProjectDetailCompatible rejects a present NON-chip-representable query', () => {
    // `qaPassed:true` is a fact atom — NOT chip-representable → ProjectDetail
    // (chips-only) cannot render it.
    expect(isProjectDetailCompatible(configWith({ query: 'qaPassed:true' }), 'syntaur')).toBe(false);
    // An OR query is also non-chip-representable.
    expect(
      isProjectDetailCompatible(configWith({ query: 'status:draft OR status:review' }), 'syntaur'),
    ).toBe(false);
  });

  it('isProjectDetailCompatible allows a chip-representable query or an absent query', () => {
    // `status:in_progress` round-trips to chip state → compatible.
    expect(
      isProjectDetailCompatible(configWith({ query: 'status:in_progress' }), 'syntaur'),
    ).toBe(true);
    // No query at all → unaffected (compatible).
    expect(isProjectDetailCompatible(configWith({}), 'syntaur')).toBe(true);
    // Blank query → treated as absent → compatible.
    expect(isProjectDetailCompatible(configWith({ query: '   ' }), 'syntaur')).toBe(true);
  });
});

// ── Session view schema validation (Task 9) ────────────────────────────────────
describe('session view schema validators', () => {
  it('isSavedView accepts a session view with entityType: session', () => {
    const view = {
      id: 'test-session-view',
      name: 'My Session View',
      workspace: null,
      entityType: 'session',
      config: {
        viewMode: 'list',
        filters: {},
        sortField: 'started',
        sortDirection: 'desc',
        limit: 10,
        listSectionVisibility: { collapsed: [] },
        kanbanColumnVisibility: { hidden: [] },
        tableColumnVisibility: { hidden: [] },
      },
      createdAt: '2026-06-12T00:00:00Z',
      updatedAt: '2026-06-12T00:00:00Z',
    };
    expect(isSavedView(view)).toBe(true);
  });

  it('isSavedView rejects an invalid entityType', () => {
    const view = {
      id: 'test-session-view',
      name: 'Bad',
      workspace: null,
      entityType: 'server',
      config: {
        viewMode: 'list',
        filters: {},
        sortField: 'started',
        sortDirection: 'desc',
        listSectionVisibility: { collapsed: [] },
        kanbanColumnVisibility: { hidden: [] },
        tableColumnVisibility: { hidden: [] },
      },
      createdAt: '2026-06-12T00:00:00Z',
      updatedAt: '2026-06-12T00:00:00Z',
    };
    expect(isSavedView(view)).toBe(false);
  });

  it('isSavedView accepts absent entityType (backward compat)', () => {
    const view = {
      id: 'legacy-view',
      name: 'Legacy',
      workspace: null,
      config: {
        viewMode: 'list',
        filters: {},
        sortField: 'updated',
        sortDirection: 'desc',
        listSectionVisibility: { collapsed: [] },
        kanbanColumnVisibility: { hidden: [] },
        tableColumnVisibility: { hidden: [] },
      },
      createdAt: '2026-06-12T00:00:00Z',
      updatedAt: '2026-06-12T00:00:00Z',
    };
    expect(isSavedView(view)).toBe(true);
  });

  it('isSavedViewConfig accepts config with limit', () => {
    const config = {
      viewMode: 'list',
      filters: {},
      sortField: 'started',
      sortDirection: 'desc',
      limit: 25,
      listSectionVisibility: { collapsed: [] },
      kanbanColumnVisibility: { hidden: [] },
      tableColumnVisibility: { hidden: [] },
    };
    expect(isSavedViewConfig(config)).toBe(true);
  });

  it('isWidgetConfig accepts agent-sessions with viewId', () => {
    expect(isWidgetConfig({ kind: 'agent-sessions', viewId: 'abc' })).toBe(true);
  });

  it('isWidgetConfig rejects agent-sessions with non-string viewId', () => {
    expect(isWidgetConfig({ kind: 'agent-sessions', viewId: 123 })).toBe(false);
  });

  it('isWidgetConfig accepts agent-sessions without viewId', () => {
    expect(isWidgetConfig({ kind: 'agent-sessions' })).toBe(true);
  });

  for (const kind of ['token-usage', 'spend'] as const) {
    it(`isWidgetConfig accepts ${kind} with no filters`, () => {
      expect(isWidgetConfig({ kind })).toBe(true);
    });
    it(`isWidgetConfig accepts ${kind} with a full valid filter set`, () => {
      expect(
        isWidgetConfig({
          kind,
          filters: {
            window: 'custom',
            since: '2026-01-01',
            until: '2026-02-01',
            project: 'syntaur-meta',
            workspace: 'backend',
            model: 'claude-opus-4-8',
            tool: 'claude',
          },
        }),
      ).toBe(true);
    });
    it(`isWidgetConfig accepts ${kind} with unknown extra filter keys (forward-compat)`, () => {
      expect(isWidgetConfig({ kind, filters: { window: '7d', future: 'x' } })).toBe(true);
    });
    it(`isWidgetConfig rejects ${kind} with an invalid window`, () => {
      expect(isWidgetConfig({ kind, filters: { window: '13d' } })).toBe(false);
    });
    it(`isWidgetConfig rejects ${kind} with an impossible date`, () => {
      expect(isWidgetConfig({ kind, filters: { window: 'custom', since: '2026-02-30' } })).toBe(false);
    });
    it(`isWidgetConfig rejects ${kind} with a non-string field`, () => {
      expect(isWidgetConfig({ kind, filters: { project: 5 } })).toBe(false);
    });
    it(`isWidgetConfig rejects ${kind} with a null field`, () => {
      expect(isWidgetConfig({ kind, filters: { model: null } })).toBe(false);
    });
    it(`isWidgetConfig rejects ${kind} with an array field`, () => {
      expect(isWidgetConfig({ kind, filters: { tool: ['a'] } })).toBe(false);
    });
    it(`isWidgetConfig rejects ${kind} with non-object filters`, () => {
      expect(isWidgetConfig({ kind, filters: 'nope' })).toBe(false);
    });
  }

  it('isDashboardSlot rejects a slot holding a malformed usage widget (legacy fallback)', () => {
    expect(isDashboardSlot({ id: 'slot-x', widget: { kind: 'spend', filters: { window: '13d' } } })).toBe(false);
    // …and accepts the same slot once the config is valid (round-trip sanity).
    expect(isDashboardSlot({ id: 'slot-x', widget: { kind: 'spend', filters: { window: '30d' } } })).toBe(true);
  });

  it('createSavedView persists entityType: session when provided', () => {
    const file = JSON.parse(JSON.stringify(DEFAULT_SAVED_VIEWS_FILE));
    const result = createSavedView(file, {
      name: 'Session View',
      workspace: null,
      entityType: 'session',
      config: {
        viewMode: 'list',
        filters: {},
        sortField: 'started',
        sortDirection: 'desc',
        limit: 5,
        listSectionVisibility: { collapsed: [] },
        kanbanColumnVisibility: { hidden: [] },
        tableColumnVisibility: { hidden: [] },
      },
    });
    expect(result.view.entityType).toBe('session');
    expect(result.view.config.limit).toBe(5);
    expect(result.view.config.sortField).toBe('started');
  });

  it('createSavedView defaults to an assignment view when entityType is omitted', () => {
    const file = JSON.parse(JSON.stringify(DEFAULT_SAVED_VIEWS_FILE));
    const result = createSavedView(file, {
      name: 'Plain View',
      workspace: null,
      config: {
        viewMode: 'kanban',
        filters: {},
        sortField: 'updated',
        sortDirection: 'desc',
        listSectionVisibility: { collapsed: [] },
        kanbanColumnVisibility: { hidden: [] },
        tableColumnVisibility: { hidden: [] },
      },
    });
    // Absent === assignment: entityType is not written, preserving backward compat.
    expect(result.view.entityType).toBeUndefined();
  });

  it('updateSavedView preserves entityType across edits (powers session edit + duplicate)', () => {
    const seed = JSON.parse(JSON.stringify(DEFAULT_SAVED_VIEWS_FILE));
    const { file, view } = createSavedView(seed, {
      name: 'Session View',
      workspace: null,
      entityType: 'session',
      config: {
        viewMode: 'list',
        filters: {},
        sortField: 'started',
        sortDirection: 'desc',
        limit: 5,
        listSectionVisibility: { collapsed: [] },
        kanbanColumnVisibility: { hidden: [] },
        tableColumnVisibility: { hidden: [] },
      },
    });
    const result = updateSavedView(file, view.id, { name: 'Renamed Session View' });
    expect('view' in result).toBe(true);
    if ('view' in result) {
      expect(result.view.entityType).toBe('session');
      expect(result.view.name).toBe('Renamed Session View');
    }
  });

  it('round-trips a session view through write/read', async () => {
    const originalHome = process.env.HOME;
    const homeDir = await mkdtemp(join(tmpdir(), 'syntaur-session-view-'));
    process.env.HOME = homeDir;
    await mkdir(resolve(homeDir, '.syntaur'), { recursive: true });

    const file: SavedViewsFile = {
      version: 1,
      views: [
        {
          id: 'sv-1',
          name: 'Recent sessions',
          workspace: null,
          entityType: 'session',
          config: {
            viewMode: 'list',
            filters: { agent: ['codex'] },
            sortField: 'started',
            sortDirection: 'desc',
            limit: 20,
            listSectionVisibility: { collapsed: [] },
            kanbanColumnVisibility: { hidden: [] },
            tableColumnVisibility: { hidden: [] },
          },
          createdAt: '2026-06-12T00:00:00Z',
          updatedAt: '2026-06-12T00:00:00Z',
        },
      ],
      dashboard: {
        version: 1,
        slots: [{ id: 'slot-0', widget: { kind: 'agent-sessions', viewId: 'sv-1' } }],
      },
    };

    await writeSavedViewsFile(file);
    const read = await readSavedViewsFile();
    expect(read.views[0].entityType).toBe('session');
    expect(read.views[0].config.limit).toBe(20);
    expect(read.dashboard.slots[0].widget).toEqual({ kind: 'agent-sessions', viewId: 'sv-1' });

    process.env.HOME = originalHome;
    await rm(homeDir, { recursive: true, force: true });
  });
});
