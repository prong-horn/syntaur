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
import {
  renderTimelineTable,
  runTimeline,
  summarizeTimelineEvent,
} from '../commands/timeline.js';

let home: string;
let projectsDir: string;
let dbPath: string;
let prevHome: string | undefined;

const PROJECT = 'p1';
const SLUG = 'a1';
const TICKET_ID = 'PJ-1';

const T1 = '2026-01-01T00:00:00Z';
const T2 = '2026-02-01T00:00:00Z';
const T3 = '2026-03-01T00:00:00Z';

function ticketMd(slug: string, id: string): string {
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
depends_on: []
links: []
blocked: null
workspace:
  repository: null
  worktree: null
  branch: null
  parentBranch: null
tags: []
---

# ${slug}
`;
}

async function seedProject(project: string, slug: string, id: string): Promise<void> {
  const dir = resolve(projectsDir, project, 'tickets', `${id}-${slug}`);
  await mkdir(dir, { recursive: true });
  await writeFile(resolve(dir, 'ticket.md'), ticketMd(slug, id), 'utf-8');
  // project.md is required by resolveTicketTarget's --project path.
  await writeFile(
    resolve(projectsDir, project, 'project.md'),
    `---\nslug: ${project}\ntitle: "${project}"\n---\n`,
    'utf-8',
  );
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'syntaur-timeline-'));
  projectsDir = resolve(home, 'projects');
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
    await seedProject(PROJECT, SLUG, TICKET_ID);
    recordEvent({
      ticketId: TICKET_ID,
      type: 'moved',
      actor: 'human',
      at: T1,
      details: { from: 'backlog', to: 'in_progress', verb: 'work-start' },
    });
    recordEvent({ ticketId: TICKET_ID, type: 'fact-set', actor: 'agent:x', at: T2, details: { name: 'foo', value: 'bar' } });
    recordEvent({ ticketId: TICKET_ID, type: 'plan-approved', actor: 'agent:y', at: T3, details: { file: 'plan.md' } });

    const events = await runTimeline(TICKET_ID, { project: PROJECT });
    expect(events.map((e) => e.at)).toEqual([T3, T2, T1]);
    expect(events.map((e) => e.type)).toEqual(['plan-approved', 'fact-set', 'moved']);
    // details parsed into an object, not a raw string
    expect(events[2].details).toEqual({ from: 'backlog', to: 'in_progress', verb: 'work-start' });
    expect(typeof events[0].details).toBe('object');
  });

  it('--json shape: each event has parsed details + the core columns', async () => {
    await seedProject(PROJECT, SLUG, TICKET_ID);
    recordEvent({
      ticketId: TICKET_ID,
      type: 'moved',
      actor: 'human',
      at: T1,
      details: { from: 'backlog', to: 'in_progress', verb: 'work-start' },
    });

    const events = await runTimeline(TICKET_ID, { project: PROJECT });
    expect(events).toHaveLength(1);
    const e = events[0];
    expect(e.ticket_id).toBe(TICKET_ID);
    expect(e.actor).toBe('human');
    expect(e.type).toBe('moved');
    expect(e.at).toBe(T1);
    expect(e.details).toEqual({ from: 'backlog', to: 'in_progress', verb: 'work-start' });
    // JSON serialization round-trips cleanly (this is what --json prints).
    const parsed = JSON.parse(JSON.stringify(events));
    expect(parsed[0].details.to).toBe('in_progress');
  });

  it('--since filters out events strictly before the bound', async () => {
    await seedProject(PROJECT, SLUG, TICKET_ID);
    recordEvent({ ticketId: TICKET_ID, type: 'moved', actor: 'human', at: T1 });
    recordEvent({ ticketId: TICKET_ID, type: 'moved', actor: 'human', at: T2 });
    recordEvent({ ticketId: TICKET_ID, type: 'moved', actor: 'human', at: T3 });

    const events = await runTimeline(TICKET_ID, { project: PROJECT, since: T2 });
    expect(events.map((e) => e.at)).toEqual([T3, T2]);
  });

  it('--type filters to the requested event types', async () => {
    await seedProject(PROJECT, SLUG, TICKET_ID);
    recordEvent({ ticketId: TICKET_ID, type: 'moved', actor: 'human', at: T1 });
    recordEvent({ ticketId: TICKET_ID, type: 'fact-set', actor: 'human', at: T2 });
    recordEvent({ ticketId: TICKET_ID, type: 'plan-approved', actor: 'human', at: T3 });

    const events = await runTimeline(TICKET_ID, { project: PROJECT, type: ['fact-set', 'plan-approved'] });
    expect(events.map((e) => e.type)).toEqual(['plan-approved', 'fact-set']);
  });

  it('--limit caps the number of events returned', async () => {
    await seedProject(PROJECT, SLUG, TICKET_ID);
    recordEvent({ ticketId: TICKET_ID, type: 'moved', actor: 'human', at: T1 });
    recordEvent({ ticketId: TICKET_ID, type: 'moved', actor: 'human', at: T2 });
    recordEvent({ ticketId: TICKET_ID, type: 'moved', actor: 'human', at: T3 });

    const events = await runTimeline(TICKET_ID, { project: PROJECT, limit: 2 });
    // newest-first, so the two newest survive
    expect(events.map((e) => e.at)).toEqual([T3, T2]);
  });

  it('summarizes moved and plan-approved rows for the table view', () => {
    expect(
      summarizeTimelineEvent({
        ticket_id: TICKET_ID,
        project_slug: PROJECT,
        type: 'moved',
        actor: 'human',
        at: T1,
        details: { from: 'ready', to: 'in_progress', verb: 'work-start' },
        source_key: null,
        event_id: 'e1',
      }),
    ).toBe('ready → in_progress (work-start)');
    expect(
      summarizeTimelineEvent({
        ticket_id: TICKET_ID,
        project_slug: PROJECT,
        type: 'plan-approved',
        actor: 'human',
        at: T2,
        details: { file: 'plan.md' },
        source_key: null,
        event_id: 'e2',
      }),
    ).toBe('plan.md');
  });

  it('summarizes logged events with type and verdict', () => {
    expect(
      summarizeTimelineEvent({
        ticket_id: TICKET_ID,
        project_slug: PROJECT,
        type: 'logged',
        actor: 'human',
        at: T2,
        details: { type: 'review', verdict: 'approve' },
        source_key: null,
        event_id: 'e3',
      }),
    ).toBe('review (approve)');
  });

  it('renderTimelineTable formats an empty list', () => {
    expect(renderTimelineTable([])).toBe('No events.');
  });

  it('resolves a ticket by id and returns its events', async () => {
    await seedProject(PROJECT, 'solo', TICKET_ID);
    recordEvent({ ticketId: TICKET_ID, type: 'moved', actor: 'human', at: T1 });

    const events = await runTimeline(TICKET_ID, {});
    expect(events).toHaveLength(1);
    expect(events[0].ticket_id).toBe(TICKET_ID);
  });
});
