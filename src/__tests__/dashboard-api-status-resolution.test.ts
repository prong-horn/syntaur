import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, readFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createStatusConfigRouter } from '../dashboard/api-status-config.js';
import { clearStatusConfigCache } from '../dashboard/api.js';

const originalHome = process.env.HOME;
const originalSyntaurHome = process.env.SYNTAUR_HOME;

let tmpHome: string;
let projectsDir: string;
let standaloneDir: string;
let server: Server;
let baseUrl: string;

const baseStatuses = [
  { id: 'pending', label: 'Pending' },
  { id: 'in_progress', label: 'In progress' },
  { id: 'completed', label: 'Completed', terminal: true },
];
const baseOrder = baseStatuses.map((s) => s.id);

async function seedAssignment(dir: string, slug: string, status: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  const md = `---
id: 11111111-1111-1111-1111-${slug.padEnd(12, '0').slice(0, 12)}
slug: ${slug}
title: ${slug}
status: ${status}
priority: medium
created: "2026-01-01T00:00:00Z"
updated: "2026-01-01T00:00:00Z"
assignee: null
externalIds: []
dependsOn: []
links: []
blockedReason: null
workspace:
  repository: null
  worktreePath: null
  branch: null
  parentBranch: null
tags: []
---

# ${slug}
`;
  const p = join(dir, 'assignment.md');
  await writeFile(p, md);
  return p;
}

async function seedConfigStatuses(statuses: typeof baseStatuses, order: string[]): Promise<void> {
  const statusBlock = ['statuses:', '  definitions:'];
  for (const s of statuses) {
    statusBlock.push(`    - id: ${s.id}`);
    statusBlock.push(`      label: ${s.label}`);
    if (s.terminal) statusBlock.push(`      terminal: true`);
  }
  statusBlock.push('  order:');
  for (const id of order) statusBlock.push(`    - ${id}`);
  const md = `---\nversion: "2.0"\ndefaultProjectDir: ${projectsDir}\n${statusBlock.join('\n')}\n---\n`;
  await writeFile(join(tmpHome, '.syntaur', 'config.md'), md);
}

async function fileGone(path: string): Promise<boolean> {
  try {
    await access(path);
    return false;
  } catch {
    return true;
  }
}

beforeEach(async () => {
  tmpHome = await mkdtemp(join(tmpdir(), 'syntaur-status-res-api-'));
  await mkdir(join(tmpHome, '.syntaur'), { recursive: true });
  projectsDir = join(tmpHome, 'projects');
  standaloneDir = join(tmpHome, '.syntaur', 'assignments');
  await mkdir(projectsDir, { recursive: true });
  await mkdir(standaloneDir, { recursive: true });
  process.env.HOME = tmpHome;
  process.env.SYNTAUR_HOME = join(tmpHome, '.syntaur');

  await seedConfigStatuses(baseStatuses, baseOrder);
  clearStatusConfigCache();

  const app = express();
  app.use(express.json());
  app.use('/api/config/statuses', createStatusConfigRouter(projectsDir, standaloneDir));

  await new Promise<void>((ready) => {
    server = app.listen(0, () => ready());
  });
  const port = (server.address() as AddressInfo).port;
  baseUrl = `http://127.0.0.1:${port}/api/config/statuses`;
});

afterEach(async () => {
  await new Promise<void>((done) => server.close(() => done()));
  process.env.HOME = originalHome;
  if (originalSyntaurHome === undefined) delete process.env.SYNTAUR_HOME;
  else process.env.SYNTAUR_HOME = originalSyntaurHome;
  await rm(tmpHome, { recursive: true, force: true });
  clearStatusConfigCache();
});

describe('GET /affected/:id', () => {
  it('returns count + sample for a status with affected assignments', async () => {
    await seedAssignment(join(projectsDir, 'p1', 'assignments', 'a1'), 'a1', 'pending');
    await seedAssignment(join(projectsDir, 'p1', 'assignments', 'a2'), 'a2', 'pending');
    await seedAssignment(join(projectsDir, 'p1', 'assignments', 'a3'), 'a3', 'in_progress');

    const res = await fetch(`${baseUrl}/affected/pending`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe('pending');
    expect(body.count).toBe(2);
    expect(body.truncated).toBe(false);
    expect(body.assignments).toHaveLength(2);
    expect(body.assignments[0].display).toMatch(/p1\/a[12]/);
  });

  it('returns count=0 for an id with no assignments', async () => {
    const res = await fetch(`${baseUrl}/affected/in_progress`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.count).toBe(0);
    expect(body.assignments).toEqual([]);
  });
});

describe('POST / — resolution-aware writes', () => {
  it('(a) zero-affected drop succeeds without resolutions', async () => {
    // Drop "completed" — no assignment is on completed.
    const newStatuses = baseStatuses.filter((s) => s.id !== 'completed');
    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        statuses: newStatuses,
        order: newStatuses.map((s) => s.id),
        transitions: [],
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.statuses.map((s: { id: string }) => s.id)).not.toContain('completed');
  });

  it('(b) drop with remap rewrites frontmatters + writes config', async () => {
    const a1Path = await seedAssignment(join(projectsDir, 'p1', 'assignments', 'a1'), 'a1', 'pending');
    const a2Path = await seedAssignment(join(projectsDir, 'p1', 'assignments', 'a2'), 'a2', 'pending');

    const newStatuses = baseStatuses.filter((s) => s.id !== 'pending');
    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        statuses: newStatuses,
        order: newStatuses.map((s) => s.id),
        transitions: [],
        resolutions: [{ id: 'pending', mode: 'remap', target: 'in_progress' }],
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.applied.remapped).toBe(2);
    expect(body.applied.deleted).toBe(0);
    expect(body.applied.byId.pending).toEqual({ mode: 'remap', count: 2, target: 'in_progress' });

    const a1 = await readFile(a1Path, 'utf-8');
    const a2 = await readFile(a2Path, 'utf-8');
    expect(a1).toMatch(/^status: in_progress$/m);
    expect(a2).toMatch(/^status: in_progress$/m);
  });

  it('(c) drop with delete removes assignment dirs + writes config', async () => {
    const a1Path = await seedAssignment(join(projectsDir, 'p1', 'assignments', 'a1'), 'a1', 'pending');
    const a2Path = await seedAssignment(join(projectsDir, 'p1', 'assignments', 'a2'), 'a2', 'pending');

    const newStatuses = baseStatuses.filter((s) => s.id !== 'pending');
    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        statuses: newStatuses,
        order: newStatuses.map((s) => s.id),
        transitions: [],
        resolutions: [{ id: 'pending', mode: 'delete' }],
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.applied.deleted).toBe(2);
    expect(await fileGone(a1Path)).toBe(true);
    expect(await fileGone(a2Path)).toBe(true);
  });

  it('(d) drop with affected and no resolution → 409 unresolved-orphans with sample', async () => {
    await seedAssignment(join(projectsDir, 'p1', 'assignments', 'a1'), 'a1', 'pending');

    const newStatuses = baseStatuses.filter((s) => s.id !== 'pending');
    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        statuses: newStatuses,
        order: newStatuses.map((s) => s.id),
        transitions: [],
      }),
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe('unresolved-orphans');
    expect(body.unresolved).toHaveLength(1);
    expect(body.unresolved[0]).toMatchObject({ id: 'pending', count: 1 });
    expect(body.unresolved[0].assignments).toHaveLength(1);
  });

  it('(e) malformed resolutions payload → 400 malformed-resolutions', async () => {
    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        statuses: baseStatuses,
        order: baseOrder,
        transitions: [],
        resolutions: 'not-an-array',
      }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('malformed-resolutions');
  });

  it('(f) remap target not in newStatuses → 400 invalid-remap-target not-in-new-config', async () => {
    await seedAssignment(join(projectsDir, 'p1', 'assignments', 'a1'), 'a1', 'pending');

    const newStatuses = baseStatuses.filter((s) => s.id !== 'pending');
    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        statuses: newStatuses,
        order: newStatuses.map((s) => s.id),
        transitions: [],
        resolutions: [{ id: 'pending', mode: 'remap', target: 'nonexistent' }],
      }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('invalid-remap-target');
    expect(body.reason).toBe('not-in-new-config');
  });

  it('(g) remap target is brand-new status (not in oldIds) → 400 not-in-old-config', async () => {
    await seedAssignment(join(projectsDir, 'p1', 'assignments', 'a1'), 'a1', 'pending');

    // Add a brand-new status "triage" and drop "pending" remapping to "triage".
    const newStatuses = [
      ...baseStatuses.filter((s) => s.id !== 'pending'),
      { id: 'triage', label: 'Triage' },
    ];
    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        statuses: newStatuses,
        order: newStatuses.map((s) => s.id),
        transitions: [],
        resolutions: [{ id: 'pending', mode: 'remap', target: 'triage' }],
      }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('invalid-remap-target');
    expect(body.reason).toBe('not-in-old-config');
  });

  it('(h) duplicate resolution ids → 400 duplicate-resolution-ids', async () => {
    await seedAssignment(join(projectsDir, 'p1', 'assignments', 'a1'), 'a1', 'pending');

    const newStatuses = baseStatuses.filter((s) => s.id !== 'pending');
    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        statuses: newStatuses,
        order: newStatuses.map((s) => s.id),
        transitions: [],
        resolutions: [
          { id: 'pending', mode: 'remap', target: 'in_progress' },
          { id: 'pending', mode: 'delete' },
        ],
      }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('duplicate-resolution-ids');
    expect(body.ids).toContain('pending');
  });

  it('(i) stale resolution (id not in droppedIds) → 400 stale-resolution', async () => {
    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        statuses: baseStatuses,
        order: baseOrder,
        transitions: [],
        resolutions: [{ id: 'pending', mode: 'delete' }], // not dropping pending
      }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('stale-resolution');
    expect(body.id).toBe('pending');
  });

  it('(k) per-resolution counts in applied.byId reflect actual writes (not scan-time list size)', async () => {
    await seedAssignment(join(projectsDir, 'p1', 'assignments', 'a1'), 'a1', 'pending');
    await seedAssignment(join(projectsDir, 'p1', 'assignments', 'a2'), 'a2', 'pending');

    const newStatuses = baseStatuses.filter((s) => s.id !== 'pending');
    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        statuses: newStatuses,
        order: newStatuses.map((s) => s.id),
        transitions: [],
        resolutions: [{ id: 'pending', mode: 'remap', target: 'in_progress' }],
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.applied.byId.pending).toEqual({ mode: 'remap', count: 2, target: 'in_progress' });
  });

  it('(j) remap target same as source → 400 invalid-remap-target same-as-source', async () => {
    await seedAssignment(join(projectsDir, 'p1', 'assignments', 'a1'), 'a1', 'pending');

    // Drop pending. Resolution target = 'pending' (same as source).
    const newStatuses = baseStatuses.filter((s) => s.id !== 'pending');
    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        statuses: newStatuses,
        order: newStatuses.map((s) => s.id),
        transitions: [],
        resolutions: [{ id: 'pending', mode: 'remap', target: 'pending' }],
      }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('invalid-remap-target');
    expect(body.reason).toBe('same-as-source');
  });
});

describe('GET / — existing handler preserved by refactor', () => {
  it('returns statuses + order + transitions + custom flag', async () => {
    const res = await fetch(baseUrl);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.statuses.map((s: { id: string }) => s.id)).toEqual(baseOrder);
    expect(body.custom).toBe(true);
  });
});

describe('DELETE / — existing handler preserved by refactor', () => {
  it('clears custom config and returns defaults', async () => {
    const res = await fetch(baseUrl, { method: 'DELETE' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.custom).toBe(false);
  });
});
