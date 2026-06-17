import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { executeTransition } from '../lifecycle/transitions.js';
import { factSetCommand } from '../commands/derive-verbs.js';
import { migrateStatusHistoryCommand } from '../commands/migrate-status-history.js';
import { parseAssignmentFrontmatter } from '../lifecycle/frontmatter.js';
import {
  initEventsDb,
  closeEventsDb,
  resetEventsDb,
  listEventsByAssignment,
} from '../db/events-db.js';
import {
  recordStatusEvent,
  withSuppressedEvents,
} from '../lifecycle/event-emit.js';

let home: string;
let prevHome: string | undefined;

// A minimal custom-status config with one declared bool fact, so `fact set`
// runs through the derive spine without moving the headline status.
function configMd(projectsDir: string): string {
  return `---
version: "2.0"
defaultProjectDir: ${projectsDir}
statuses:
  definitions:
    - id: draft
      label: Draft
    - id: ready_for_planning
      label: Ready for Planning
    - id: ready_to_implement
      label: Ready to Implement
    - id: in_progress
      label: In Progress
    - id: review
      label: Review
    - id: blocked
      label: Blocked
    - id: completed
      label: Completed
      terminal: true
    - id: failed
      label: Failed
      terminal: true
  order:
    - draft
    - ready_for_planning
    - ready_to_implement
    - in_progress
    - review
    - blocked
    - completed
    - failed
  facts:
    - name: qaPassed
      type: bool
  phaseLadder:
    - phase: draft
      when: "*"
  disposition:
    - when: "blocked:true"
      is: blocked
    - else: active
  headline:
    terminal: passthrough
    parked: blocked
    blocked: blocked
    active: phase
---
`;
}

function assignmentMd(): string {
  return `---
id: feat-x-id
slug: feat-x
title: "Feat X"
project: p1
status: draft
priority: medium
created: "2026-06-09T10:00:00Z"
updated: "2026-06-09T10:00:00Z"
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

# Feat X

## Objective

A real objective.
`;
}

let projectDir: string;
let assignmentPath: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'syntaur-event-emit-'));
  prevHome = process.env.SYNTAUR_HOME;
  process.env.SYNTAUR_HOME = home;
  // Reset the events-db singleton so it lazily re-opens at THIS home's db.
  resetEventsDb();

  await writeFile(join(home, 'config.md'), configMd(resolve(home, 'projects')));
  projectDir = join(home, 'projects', 'p1');
  const aDir = join(projectDir, 'assignments', 'feat-x');
  await mkdir(aDir, { recursive: true });
  await writeFile(join(projectDir, 'project.md'), '---\nslug: p1\n---\n# P1\n');
  assignmentPath = join(aDir, 'assignment.md');
  await writeFile(assignmentPath, assignmentMd());
});

afterEach(async () => {
  closeEventsDb();
  resetEventsDb();
  if (prevHome === undefined) delete process.env.SYNTAUR_HOME;
  else process.env.SYNTAUR_HOME = prevHome;
  await rm(home, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** Open the events db that the live emits wrote to under SYNTAUR_HOME. */
function openEvents() {
  return initEventsDb(resolve(home, 'syntaur.db'));
}

async function readFm() {
  return parseAssignmentFrontmatter(await readFile(assignmentPath, 'utf-8'));
}

describe('recordStatusEvent self-guard (R5)', () => {
  it('emits nothing when from === to', () => {
    openEvents();
    recordStatusEvent({
      assignmentId: 'a1',
      projectSlug: 'p1',
      actor: 'human',
      from: 'draft',
      to: 'draft',
      command: 'edit',
    });
    expect(listEventsByAssignment('a1')).toHaveLength(0);
  });

  it('emits one status-change when from !== to', () => {
    openEvents();
    recordStatusEvent({
      assignmentId: 'a1',
      projectSlug: 'p1',
      actor: 'human',
      from: 'draft',
      to: 'review',
      command: 'edit',
    });
    const events = listEventsByAssignment('a1');
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('status-change');
  });
});

describe('CLI status transition emits exactly one status-change', () => {
  it('records one status-change with correct from/to/actor', async () => {
    const result = await executeTransition(projectDir, 'feat-x', 'shape', { agent: 'codex' });
    expect(result.success).toBe(true);
    const id = (await readFm()).id;

    openEvents(); // no-op if the live emit already opened the singleton
    const events = listEventsByAssignment(id);
    const statusEvents = events.filter((e) => e.type === 'status-change');
    expect(statusEvents).toHaveLength(1);
    const details = JSON.parse(statusEvents[0].details ?? '{}');
    expect(details.from).toBe('draft');
    expect(details.to).toBe('ready_for_planning');
    expect(statusEvents[0].actor).toBe('codex');
  });
});

describe('same-status fact set (R5)', () => {
  it('records a fact-set event and ZERO status-change events', async () => {
    const before = (await readFm()).status;
    await factSetCommand('feat-x', 'qaPassed', 'true', { project: 'p1' });
    const after = (await readFm()).status;
    // qaPassed does not feed any rung here → headline unchanged.
    expect(after).toBe(before);

    const id = (await readFm()).id;
    openEvents();
    const events = listEventsByAssignment(id);
    expect(events.filter((e) => e.type === 'fact-set')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'status-change')).toHaveLength(0);
  });
});

describe('migration suppression', () => {
  it('migrate-status-history --apply records ZERO live events', async () => {
    // feat-x has no statusHistory → the migration seeds one. defaultProjectDir
    // (from config.md) is <home>/projects, so no --dir is needed.
    const id = (await readFm()).id;
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await migrateStatusHistoryCommand({ apply: true });
    logSpy.mockRestore();

    // The migration seeded a statusHistory entry but must emit NO live event.
    expect((await readFm()).statusHistory.length).toBeGreaterThan(0);
    openEvents();
    expect(listEventsByAssignment(id)).toHaveLength(0);
  });

  it('withSuppressedEvents suppresses recordStatusEvent and restores after', () => {
    openEvents();
    withSuppressedEvents(() => {
      recordStatusEvent({
        assignmentId: 's1',
        projectSlug: null,
        actor: 'human',
        from: 'draft',
        to: 'review',
        command: 'edit',
      });
    });
    expect(listEventsByAssignment('s1')).toHaveLength(0);
    // Restored: a post-suppression emit lands.
    recordStatusEvent({
      assignmentId: 's1',
      projectSlug: null,
      actor: 'human',
      from: 'draft',
      to: 'review',
      command: 'edit',
    });
    expect(listEventsByAssignment('s1')).toHaveLength(1);
  });
});

describe('best-effort: a forced events-db failure leaves the transition succeeding', () => {
  it('transition still writes the status even when the events db is unopenable', async () => {
    // Make the events db path a DIRECTORY so better-sqlite3 cannot open it as a
    // file — recordEvent's lazy initEventsDb() throws, and recordEvent swallows
    // it (best-effort). The transition's own file write must still commit.
    resetEventsDb();
    await mkdir(resolve(home, 'syntaur.db'), { recursive: true });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    let threw = false;
    try {
      await executeTransition(projectDir, 'feat-x', 'shape', { agent: 'codex' });
    } catch {
      threw = true;
    }
    warnSpy.mockRestore();

    expect(threw).toBe(false);
    expect((await readFm()).status).toBe('ready_for_planning');
  });
});
