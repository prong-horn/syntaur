import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  initEventsDb,
  closeEventsDb,
  resetEventsDb,
  recordEvent,
} from '../db/events-db.js';
import { runTimeline } from '../commands/timeline.js';

let home: string;
let projectsDir: string;
let standaloneDir: string;
let dbPath: string;
let prevHome: string | undefined;

const PROJECT = 'p1';
const SLUG = 'a1';
const ASSIGNMENT_ID = 'a1-id';

const T1 = '2026-01-01T00:00:00Z';
const T2 = '2026-02-01T00:00:00Z';
const T3 = '2026-03-01T00:00:00Z';

function assignmentMd(slug: string, id: string): string {
  return `---
id: ${id}
slug: ${slug}
title: "${slug}"
status: in_progress
priority: medium
created: "${T1}"
updated: "${T3}"
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
}

async function seedProject(project: string, slug: string, id: string): Promise<void> {
  const dir = resolve(projectsDir, project, 'assignments', slug);
  await mkdir(dir, { recursive: true });
  await writeFile(resolve(dir, 'assignment.md'), assignmentMd(slug, id), 'utf-8');
  // project.md is required by resolveAssignmentTarget's --project path.
  await writeFile(
    resolve(projectsDir, project, 'project.md'),
    `---\nslug: ${project}\ntitle: "${project}"\n---\n`,
    'utf-8',
  );
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'syntaur-timeline-'));
  projectsDir = resolve(home, 'projects');
  standaloneDir = resolve(home, 'assignments');
  dbPath = resolve(home, 'syntaur.db');
  prevHome = process.env.SYNTAUR_HOME;
  process.env.SYNTAUR_HOME = home;
  // DEFAULT_CONFIG.defaultProjectDir is captured at module load (real ~/.syntaur),
  // so write an explicit config.md pointing readConfig at the temp projects dir.
  await writeFile(
    resolve(home, 'config.md'),
    `---\nversion: "2.0"\ndefaultProjectDir: ${projectsDir}\n---\n`,
    'utf-8',
  );
  resetEventsDb();
  // Open the singleton against the temp DB so runTimeline's initEventsDb() reuses it.
  initEventsDb(dbPath);
});

afterEach(async () => {
  if (prevHome === undefined) delete process.env.SYNTAUR_HOME;
  else process.env.SYNTAUR_HOME = prevHome;
  closeEventsDb();
  resetEventsDb();
  await rm(home, { recursive: true, force: true });
});

describe('runTimeline', () => {
  it('returns events newest-first with parsed details', async () => {
    await seedProject(PROJECT, SLUG, ASSIGNMENT_ID);
    recordEvent({ assignmentId: ASSIGNMENT_ID, type: 'status-change', actor: 'human', at: T1, details: { from: null, to: 'in_progress', command: 'create' } });
    recordEvent({ assignmentId: ASSIGNMENT_ID, type: 'fact-set', actor: 'agent:x', at: T2, details: { name: 'foo', value: 'bar' } });
    recordEvent({ assignmentId: ASSIGNMENT_ID, type: 'plan-approval', actor: 'agent:y', at: T3, details: { file: 'plan.md' } });

    const events = await runTimeline(SLUG, { project: PROJECT });
    expect(events.map((e) => e.at)).toEqual([T3, T2, T1]);
    expect(events.map((e) => e.type)).toEqual(['plan-approval', 'fact-set', 'status-change']);
    // details parsed into an object, not a raw string
    expect(events[2].details).toEqual({ from: null, to: 'in_progress', command: 'create' });
    expect(typeof events[0].details).toBe('object');
  });

  it('--json shape: each event has parsed details + the core columns', async () => {
    await seedProject(PROJECT, SLUG, ASSIGNMENT_ID);
    recordEvent({ assignmentId: ASSIGNMENT_ID, type: 'status-change', actor: 'human', at: T1, details: { from: null, to: 'in_progress', command: 'create' } });

    const events = await runTimeline(SLUG, { project: PROJECT });
    expect(events).toHaveLength(1);
    const e = events[0];
    expect(e.assignment_id).toBe(ASSIGNMENT_ID);
    expect(e.actor).toBe('human');
    expect(e.type).toBe('status-change');
    expect(e.at).toBe(T1);
    expect(e.details).toEqual({ from: null, to: 'in_progress', command: 'create' });
    // JSON serialization round-trips cleanly (this is what --json prints).
    const parsed = JSON.parse(JSON.stringify(events));
    expect(parsed[0].details.to).toBe('in_progress');
  });

  it('--since filters out events strictly before the bound', async () => {
    await seedProject(PROJECT, SLUG, ASSIGNMENT_ID);
    recordEvent({ assignmentId: ASSIGNMENT_ID, type: 'status-change', actor: 'human', at: T1 });
    recordEvent({ assignmentId: ASSIGNMENT_ID, type: 'status-change', actor: 'human', at: T2 });
    recordEvent({ assignmentId: ASSIGNMENT_ID, type: 'status-change', actor: 'human', at: T3 });

    const events = await runTimeline(SLUG, { project: PROJECT, since: T2 });
    expect(events.map((e) => e.at)).toEqual([T3, T2]);
  });

  it('--type filters to the requested event types', async () => {
    await seedProject(PROJECT, SLUG, ASSIGNMENT_ID);
    recordEvent({ assignmentId: ASSIGNMENT_ID, type: 'status-change', actor: 'human', at: T1 });
    recordEvent({ assignmentId: ASSIGNMENT_ID, type: 'fact-set', actor: 'human', at: T2 });
    recordEvent({ assignmentId: ASSIGNMENT_ID, type: 'plan-approval', actor: 'human', at: T3 });

    const events = await runTimeline(SLUG, { project: PROJECT, type: ['fact-set', 'plan-approval'] });
    expect(events.map((e) => e.type)).toEqual(['plan-approval', 'fact-set']);
  });

  it('--limit caps the number of events returned', async () => {
    await seedProject(PROJECT, SLUG, ASSIGNMENT_ID);
    recordEvent({ assignmentId: ASSIGNMENT_ID, type: 'status-change', actor: 'human', at: T1 });
    recordEvent({ assignmentId: ASSIGNMENT_ID, type: 'status-change', actor: 'human', at: T2 });
    recordEvent({ assignmentId: ASSIGNMENT_ID, type: 'status-change', actor: 'human', at: T3 });

    const events = await runTimeline(SLUG, { project: PROJECT, limit: 2 });
    // newest-first, so the two newest survive
    expect(events.map((e) => e.at)).toEqual([T3, T2]);
  });

  it('resolves a standalone assignment by UUID and returns its events', async () => {
    const uuid = '11111111-2222-3333-4444-555555555555';
    const dir = resolve(standaloneDir, uuid);
    await mkdir(dir, { recursive: true });
    await writeFile(resolve(dir, 'assignment.md'), assignmentMd(uuid, uuid), 'utf-8');
    recordEvent({ assignmentId: uuid, type: 'status-change', actor: 'human', at: T1 });

    const events = await runTimeline(uuid, {});
    expect(events).toHaveLength(1);
    expect(events[0].assignment_id).toBe(uuid);
  });
});
