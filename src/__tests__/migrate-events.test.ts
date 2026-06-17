import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  initEventsDb,
  getEventsDb,
  closeEventsDb,
  resetEventsDb,
  listEventsByAssignment,
} from '../db/events-db.js';
import { migrateEventsCommand } from '../commands/migrate-events.js';

let home: string;
let projectsDir: string;
let standaloneDir: string;
let dbPath: string;
let prevHome: string | undefined;

const C = '2026-01-01T00:00:00Z';
const U = '2026-02-02T00:00:00Z';

interface HistoryEntry {
  at: string;
  from: string | null;
  to: string;
  command: string;
  by?: string | null;
}

function assignmentMd(
  slug: string,
  id: string,
  history: HistoryEntry[],
  opts: { planApproval?: { file: string; digest: string; by?: string | null; at?: string } } = {},
): string {
  const historyBlock =
    history.length === 0
      ? 'statusHistory: []\n'
      : 'statusHistory:\n' +
        history
          .map(
            (h) =>
              `  - at: "${h.at}"\n    from: ${h.from === null ? 'null' : h.from}\n    to: ${h.to}\n    command: ${h.command}\n    by: ${h.by == null ? 'null' : h.by}\n`,
          )
          .join('');
  const planApprovalBlock = opts.planApproval
    ? `planApproval:\n  file: ${opts.planApproval.file}\n  digest: ${opts.planApproval.digest}\n  by: ${opts.planApproval.by == null ? 'null' : opts.planApproval.by}\n  at: "${opts.planApproval.at ?? U}"\n`
    : '';
  return `---
id: ${id}
slug: ${slug}
title: "${slug}"
status: in_progress
priority: medium
created: "${C}"
updated: "${U}"
assignee: null
externalIds: []
${historyBlock}${planApprovalBlock}dependsOn: []
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

async function seedProject(
  project: string,
  slug: string,
  id: string,
  history: HistoryEntry[],
  opts: { planApproval?: { file: string; digest: string; by?: string | null; at?: string } } = {},
): Promise<void> {
  const dir = resolve(projectsDir, project, 'assignments', slug);
  await mkdir(dir, { recursive: true });
  await writeFile(resolve(dir, 'assignment.md'), assignmentMd(slug, id, history, opts), 'utf-8');
}

async function seedStandalone(uuid: string, history: HistoryEntry[]): Promise<void> {
  const dir = resolve(standaloneDir, uuid);
  await mkdir(dir, { recursive: true });
  await writeFile(resolve(dir, 'assignment.md'), assignmentMd(uuid, uuid, history), 'utf-8');
}

function countAllEvents(): number {
  const row = getEventsDb().prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number };
  return row.n;
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'syntaur-migrate-events-'));
  projectsDir = resolve(home, 'projects');
  standaloneDir = resolve(home, 'assignments');
  dbPath = resolve(home, 'syntaur.db');
  prevHome = process.env.SYNTAUR_HOME;
  process.env.SYNTAUR_HOME = home;
  resetEventsDb();
  // Open the singleton against the temp DB so the command's initEventsDb() reuses it.
  initEventsDb(dbPath);
});

afterEach(async () => {
  if (prevHome === undefined) delete process.env.SYNTAUR_HOME;
  else process.env.SYNTAUR_HOME = prevHome;
  closeEventsDb();
  resetEventsDb();
  await rm(home, { recursive: true, force: true });
});

const HISTORY: HistoryEntry[] = [
  { at: C, from: null, to: 'pending', command: 'create' },
  { at: U, from: 'pending', to: 'in_progress', command: 'start', by: 'agent:abc' },
];

describe('migrateEventsCommand', () => {
  it('dry-run (default) writes nothing', async () => {
    await seedProject('p1', 'a1', 'a1-id', HISTORY);
    await migrateEventsCommand({ dir: projectsDir });
    expect(countAllEvents()).toBe(0);
  });

  it('--apply backfills one status-change event per statusHistory entry', async () => {
    await seedProject('p1', 'a1', 'a1-id', HISTORY);
    await migrateEventsCommand({ dir: projectsDir, apply: true });

    const events = listEventsByAssignment('a1-id');
    expect(events).toHaveLength(2);
    // newest-first
    expect(events.map((e) => e.at)).toEqual([U, C]);
    expect(events.every((e) => e.type === 'status-change')).toBe(true);
    // actor: entry.by ?? 'system'
    const newest = events[0];
    expect(newest.actor).toBe('agent:abc');
    expect(JSON.parse(newest.details!)).toEqual({ from: 'pending', to: 'in_progress', command: 'start' });
    const oldest = events[1];
    expect(oldest.actor).toBe('system');
    // deterministic source_key per index
    expect(newest.source_key).toBe('backfill:a1-id:status:1');
    expect(oldest.source_key).toBe('backfill:a1-id:status:0');
    // project_slug from the scan
    expect(newest.project_slug).toBe('p1');
  });

  it('re-running --apply inserts 0 (idempotent via source_key)', async () => {
    await seedProject('p1', 'a1', 'a1-id', HISTORY);
    await migrateEventsCommand({ dir: projectsDir, apply: true });
    const after1 = countAllEvents();
    expect(after1).toBe(2);

    await migrateEventsCommand({ dir: projectsDir, apply: true });
    expect(countAllEvents()).toBe(2);
  });

  it('a second assignment added after a first apply backfills only its own events', async () => {
    await seedProject('p1', 'a1', 'a1-id', HISTORY);
    await migrateEventsCommand({ dir: projectsDir, apply: true });
    expect(countAllEvents()).toBe(2);

    // Add a second assignment, then re-apply: only its 2 new events insert.
    await seedProject('p1', 'a2', 'a2-id', HISTORY);
    await migrateEventsCommand({ dir: projectsDir, apply: true });
    expect(countAllEvents()).toBe(4);
    expect(listEventsByAssignment('a1-id')).toHaveLength(2);
    expect(listEventsByAssignment('a2-id')).toHaveLength(2);
  });

  it('planApproval yields exactly one plan-approval event with the deterministic source_key', async () => {
    await seedProject('p1', 'a1', 'a1-id', HISTORY, {
      planApproval: { file: 'plan.md', digest: 'sha', by: 'agent:rev', at: '2026-03-03T00:00:00Z' },
    });
    await migrateEventsCommand({ dir: projectsDir, apply: true });

    const planEvents = listEventsByAssignment('a1-id', { types: ['plan-approval'] });
    expect(planEvents).toHaveLength(1);
    const pe = planEvents[0];
    expect(pe.at).toBe('2026-03-03T00:00:00Z');
    expect(pe.actor).toBe('agent:rev');
    expect(pe.source_key).toBe('backfill:a1-id:plan-approval');
    // status-change + plan-approval = 3 total for this assignment
    expect(listEventsByAssignment('a1-id')).toHaveLength(3);
  });

  it('backfills standalone assignments (uuid dir, project_slug null)', async () => {
    const uuid = '11111111-2222-3333-4444-555555555555';
    await seedStandalone(uuid, HISTORY);
    await migrateEventsCommand({ dir: projectsDir, apply: true });

    const events = listEventsByAssignment(uuid);
    expect(events).toHaveLength(2);
    expect(events.every((e) => e.project_slug === null)).toBe(true);
  });

  it('skips same-status statusHistory entries (from===to yields no event)', async () => {
    // A derived same-status seed (e.g. draft→draft) must produce no backfilled
    // event — matching the live emit's from!==to guard.
    const sameStatusOnly: HistoryEntry[] = [
      { at: C, from: 'draft', to: 'draft', command: 'create' },
    ];
    await seedProject('p1', 'a1', 'a1-id', sameStatusOnly);
    await migrateEventsCommand({ dir: projectsDir, apply: true });
    expect(listEventsByAssignment('a1-id')).toHaveLength(0);
    expect(countAllEvents()).toBe(0);
  });

  it('skips a same-status entry mixed among real ones, keeping original-index source_keys', async () => {
    // index 0: real (null→pending), index 1: same-status (skip), index 2: real.
    // The surviving events must keep their ORIGINAL statusHistory index in the
    // source_key so re-runs stay idempotent.
    const mixed: HistoryEntry[] = [
      { at: C, from: null, to: 'pending', command: 'create' },
      { at: U, from: 'pending', to: 'pending', command: 'touch' },
      { at: '2026-03-03T00:00:00Z', from: 'pending', to: 'in_progress', command: 'start' },
    ];
    await seedProject('p1', 'a1', 'a1-id', mixed);
    await migrateEventsCommand({ dir: projectsDir, apply: true });

    const events = listEventsByAssignment('a1-id');
    expect(events).toHaveLength(2);
    const keys = events.map((e) => e.source_key).sort();
    expect(keys).toEqual(['backfill:a1-id:status:0', 'backfill:a1-id:status:2']);
    // The skipped index 1 never appears.
    expect(keys).not.toContain('backfill:a1-id:status:1');
  });

  it('does not throw and writes nothing when there are no assignments', async () => {
    await mkdir(projectsDir, { recursive: true });
    await expect(migrateEventsCommand({ dir: projectsDir, apply: true })).resolves.toBeUndefined();
    expect(countAllEvents()).toBe(0);
  });
});
