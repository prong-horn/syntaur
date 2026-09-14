import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { moveTicket } from '../lifecycle/verbs.js';
import { parseTicketFrontmatter } from '../lifecycle/frontmatter.js';
import {
  initEventsDb,
  closeEventsDb,
  resetEventsDb,
  listEventsByTicket,
} from '../db/events-db.js';
import {
  emitMoved,
  withSuppressedEvents,
} from '../lifecycle/event-emit.js';
import { seedMissingBuiltins } from '../ticket-templates/builtins.js';

let home: string;
let prevHome: string | undefined;
let projectDir: string;
let ticketPath: string;

function ticketMd(): string {
  return `---
id: FTX-1
slug: feat-x
title: "Feat X"
project: p1
template: feature
status: backlog
priority: medium
created: "2026-06-09T10:00:00Z"
updated: "2026-06-09T10:00:00Z"
assignee: null
depends_on: []
links: []
blocked: null
parked: null
plan:
  file: null
  approvedDigest: null
  approvedAt: null
  approvedBy: null
workspace:
  repository: null
  worktree: null
  branch: null
  parentBranch: null
tags: []
---

# Feat X

## Objective

A real objective.
`;
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'syntaur-event-emit-'));
  prevHome = process.env.SYNTAUR_HOME;
  process.env.SYNTAUR_HOME = home;
  resetEventsDb();
  await seedMissingBuiltins(home);
  await writeFile(join(home, 'config.md'), `---\nversion: "2.0"\ndefaultProjectDir: ${resolve(home, 'projects')}\n---\n`);
  projectDir = join(home, 'projects', 'p1');
  const aDir = join(projectDir, 'tickets', 'FTX-1-feat-x');
  await mkdir(aDir, { recursive: true });
  await writeFile(join(projectDir, 'project.md'), '---\nslug: p1\nprefix: FTX\nnextTicket: 2\n---\n# P1\n');
  ticketPath = join(aDir, 'ticket.md');
  await writeFile(ticketPath, ticketMd());
  initEventsDb(resolve(home, 'syntaur.db'));
});

afterEach(async () => {
  closeEventsDb();
  resetEventsDb();
  if (prevHome === undefined) delete process.env.SYNTAUR_HOME;
  else process.env.SYNTAUR_HOME = prevHome;
  await rm(home, { recursive: true, force: true });
  vi.restoreAllMocks();
});

async function readFm() {
  return parseTicketFrontmatter(await readFile(ticketPath, 'utf-8'));
}

describe('moveTicket emits moved events', () => {
  it('records one moved event with correct from/to/actor', async () => {
    await moveTicket('FTX-1', 'plan', { project: 'p1', dir: resolve(home, 'projects'), agent: 'codex' });
    const id = (await readFm()).id;
    const events = listEventsByTicket(id);
    const moved = events.filter((e) => e.type === 'moved');
    expect(moved).toHaveLength(1);
    const details = JSON.parse(moved[0].details ?? '{}');
    expect(details.from).toBe('backlog');
    expect(details.to).toBe('planning');
    expect(details.verb).toBe('plan');
    expect(moved[0].actor).toBe('codex');
    expect((await readFm()).status).toBe('planning');
  });

  it('file-only approve on bug emits plan-approved without moved', async () => {
    const bugDir = join(projectDir, 'tickets', 'BG-1-bug');
    await mkdir(bugDir, { recursive: true });
    const planBody = '# Plan\n\nReal fix plan.\n';
    await writeFile(
      join(bugDir, 'ticket.md'),
      `---
id: BG-1
slug: bug
title: Bug
project: p1
template: bug
status: backlog
priority: high
created: "2026-06-09T10:00:00Z"
updated: "2026-06-09T10:00:00Z"
depends_on: []
links: []
blocked: null
parked: null
plan:
  file: plan.md
  approvedDigest: null
  approvedAt: null
  approvedBy: null
tags: []
---

# Bug
`,
    );
    await writeFile(join(bugDir, 'plan.md'), planBody, 'utf-8');
    await moveTicket('BG-1', 'approve', {
      project: 'p1',
      dir: resolve(home, 'projects'),
      agent: 'human',
    });
    const events = listEventsByTicket('BG-1');
    expect(events.filter((e) => e.type === 'moved')).toHaveLength(0);
    expect(events.filter((e) => e.type === 'plan-approved')).toHaveLength(1);
    const fm = parseTicketFrontmatter(await readFile(join(bugDir, 'ticket.md'), 'utf-8'));
    expect(fm.status).toBe('backlog');
  });
});

describe('migration suppression', () => {
  it('withSuppressedEvents suppresses emitMoved and restores after', () => {
    withSuppressedEvents(() => {
      emitMoved({
        ticketId: 's1',
        projectSlug: null,
        from: 'backlog',
        to: 'planning',
        verb: 'plan',
        by: 'human',
      });
    });
    expect(listEventsByTicket('s1')).toHaveLength(0);
    emitMoved({
      ticketId: 's1',
      projectSlug: null,
      from: 'backlog',
      to: 'planning',
      verb: 'plan',
      by: 'human',
    });
    expect(listEventsByTicket('s1')).toHaveLength(1);
  });
});

describe('best-effort: a forced events-db failure leaves the verb succeeding', () => {
  it('plan move still writes the status even when the events db is unopenable', async () => {
    closeEventsDb();
    resetEventsDb();
    const { unlink } = await import('node:fs/promises');
    await unlink(resolve(home, 'syntaur.db')).catch(() => undefined);
    await mkdir(resolve(home, 'syntaur.db'), { recursive: true });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    let threw = false;
    try {
      await moveTicket('FTX-1', 'plan', { project: 'p1', dir: resolve(home, 'projects'), agent: 'codex' });
    } catch {
      threw = true;
    }
    warnSpy.mockRestore();

    expect(threw).toBe(false);
    expect((await readFm()).status).toBe('planning');
  });
});
