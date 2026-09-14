import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import {
  listProjects,
  listTicketsBoard,
  getProjectDetail,
  getTicketDetail,
  getOverview,
  getEditableDocument,
  getHelp,
  clearStatusConfigCache,
} from '../dashboard/api.js';
import { createAgentSessionsRouter } from '../dashboard/api-agent-sessions.js';
import {
  initSessionDb,
  closeSessionDb,
  resetSessionDb,
} from '../dashboard/session-db.js';
import { compileQuery } from '../utils/query/index.js';
import { boardItemToQueryItem } from '../../dashboard/src/lib/queryFilter';
import { useHermeticSyntaurHome } from './hermetic-root.js';

// Hermetic root: these tests pass fixture configs; without a sandboxed
// SYNTAUR_HOME they read the developer’s real ~/.syntaur (ambient workflows
// dir + stages-migrated marker) — false DUAL_SOURCE errors post-2026-07-21.
useHermeticSyntaurHome();

let testDir: string;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'syntaur-test-'));
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

async function createProjectFiles(
  projectsDir: string,
  projectSlug: string,
  projectMd: string,
  tickets: Array<{
    slug: string;
    ticketMd: string;
    planMd?: string;
    scratchpadMd?: string;
    handoffMd?: string;
    decisionMd?: string;
    progressMd?: string;
    commentsMd?: string;
  }> = [],
  statusMd?: string,
): Promise<void> {
  const projectPath = resolve(projectsDir, projectSlug);
  await mkdir(projectPath, { recursive: true });
  await writeFile(resolve(projectPath, 'project.md'), projectMd, 'utf-8');

  if (statusMd) {
    await writeFile(resolve(projectPath, '_status.md'), statusMd, 'utf-8');
  }

  for (const ticket of tickets) {
    const ticketDir = resolve(projectPath, 'tickets', ticket.slug);
    await mkdir(ticketDir, { recursive: true });
    await writeFile(resolve(ticketDir, 'ticket.md'), ticket.ticketMd, 'utf-8');

    if (ticket.planMd) {
      await writeFile(resolve(ticketDir, 'plan.md'), ticket.planMd, 'utf-8');
    }
    if (ticket.scratchpadMd) {
      await writeFile(resolve(ticketDir, 'scratchpad.md'), ticket.scratchpadMd, 'utf-8');
    }
    if (ticket.handoffMd) {
      await writeFile(resolve(ticketDir, 'handoff.md'), ticket.handoffMd, 'utf-8');
    }
    if (ticket.decisionMd) {
      await writeFile(resolve(ticketDir, 'decision-record.md'), ticket.decisionMd, 'utf-8');
    }
    if (ticket.progressMd) {
      await writeFile(resolve(ticketDir, 'progress.md'), ticket.progressMd, 'utf-8');
    }
    if (ticket.commentsMd) {
      await writeFile(resolve(ticketDir, 'comments.md'), ticket.commentsMd, 'utf-8');
    }
  }
}

const COMMENTS_MD_ONE_OPEN_QUESTION = `---
ticket: test-ticket
entryCount: 1
generated: "2026-04-07T10:00:00Z"
updated: "2026-04-07T10:00:00Z"
---

# Comments

## q-1

**Recorded:** 2026-04-07T10:00:00Z
**Author:** codex-1
**Type:** question
**Resolved:** false

Waiting on approval?
`;

const PROJECT_MD = `---
id: test-123
slug: test-project
title: Test Project
archived: false
archivedAt: null
archivedReason: null
created: "2026-03-20T10:00:00Z"
updated: "2026-03-20T10:00:00Z"
externalIds:
  - system: jira
    id: TEST-1
    url: https://jira.example.com/browse/TEST-1
  - system: linear
    id: ENG-9
tags: []
---

# Test Project`;

// Use a recent date so this ticket is never stale (within the 7-day window)
const RECENT_DATE = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString().replace(/\.\d+Z$/, 'Z');

const TICKET_MD = `---
id: a-123
slug: test-ticket
title: Test Ticket
template: feature
status: in_progress
priority: high
created: "2026-03-20T10:00:00Z"
updated: "${RECENT_DATE}"
assignee: codex-1
externalIds: []
depends_on: []
blockedReason: null
workspace:
  repository: null
  worktreePath: null
  branch: null
  parentBranch: null
tags: []
---

# Test Ticket

## Questions & Answers

### Q: Waiting on approval?
**A:** pending`;

const BLOCKED_TICKET_MD = `---
id: a-456
slug: blocked-ticket
title: Blocked Ticket
status: blocked
priority: medium
created: "2026-03-20T10:00:00Z"
updated: "2026-03-10T10:00:00Z"
assignee: codex-2
externalIds: []
depends_on: []
blockedReason: Waiting on API credentials
disposition: blocked
statusHistory:
  - at: "2026-03-10T10:00:00Z"
    from: in_progress
    to: blocked
    command: block
    by: human
workspace:
  repository: null
  worktreePath: null
  branch: null
  parentBranch: null
tags: []
---

# Blocked Ticket`;

const PLAN_MD = `---
ticket: test-ticket
status: in_progress
created: "2026-03-20T10:00:00Z"
updated: "${RECENT_DATE}"
---

# Plan

- [ ] Do something`;

const SCRATCHPAD_MD = `---
ticket: test-ticket
updated: "2026-04-07T11:00:00Z"
---

# Scratchpad

Some notes`;

const HANDOFF_MD = `---
ticket: test-ticket
updated: "2026-04-07T12:00:00Z"
handoffCount: 1
---

# Handoff Log

## Handoff 1

Initial handoff`;

const DECISION_MD = `---
ticket: test-ticket
updated: "2026-04-07T13:00:00Z"
decisionCount: 1
---

# Decision Record

## Decision 1

Keep it simple`;

describe('listProjects', () => {
  it('returns empty array for a missing directory', async () => {
    const result = await listProjects(resolve(testDir, 'missing'));
    expect(result).toEqual([]);
  });

  it('uses source-first ticket state even when _status.md disagrees', async () => {
    const statusMd = `---
project: test-project
generated: "2026-03-20T10:00:00Z"
status: completed
progress:
  total: 1
  completed: 1
  in_progress: 0
  blocked: 0
  pending: 0
  review: 0
  failed: 0
needsAttention:
  blockedCount: 0
  failedCount: 0
  openQuestions: 0
---

# Status`;

    await createProjectFiles(testDir, 'test-project', PROJECT_MD, [
      {
        slug: 'test-ticket',
        ticketMd: TICKET_MD,
        commentsMd: COMMENTS_MD_ONE_OPEN_QUESTION,
      },
    ], statusMd);

    const result = await listProjects(testDir);
    expect(result).toHaveLength(1);
    expect(result[0].status).toBe('active');
    expect(result[0].progress.in_progress).toBe(1);
    expect(result[0].needsAttention.openQuestions).toBe(1);
  });
});

describe('getProjectDetail', () => {
  it('returns null for a missing project', async () => {
    const result = await getProjectDetail(testDir, 'missing');
    expect(result).toBeNull();
  });

  it('returns project detail with source-first tickets and derived graph fallback', async () => {
    await createProjectFiles(testDir, 'test-project', PROJECT_MD, [
      { slug: 'test-ticket', ticketMd: TICKET_MD },
    ]);

    const result = await getProjectDetail(testDir, 'test-project');
    expect(result).not.toBeNull();
    expect(result!.status).toBe('active');
    expect(result!.tickets[0].slug).toBe('test-ticket');
    expect(result!.dependencyGraph).toBeNull();
    expect(result!.externalIds).toHaveLength(2);
    expect(result!.externalIds[0]).toEqual({
      system: 'jira',
      id: 'TEST-1',
      url: 'https://jira.example.com/browse/TEST-1',
    });
    expect(result!.externalIds[1]).toEqual({
      system: 'linear',
      id: 'ENG-9',
      url: null,
    });
  });
});

describe('getTicketDetail', () => {
  it('returns null for a missing ticket', async () => {
    const result = await getTicketDetail(testDir, 'test-project', 'missing');
    expect(result).toBeNull();
  });

  it('returns ticket detail with companion document metadata and transitions', async () => {
    await createProjectFiles(testDir, 'test-project', PROJECT_MD, [
      {
        slug: 'test-ticket',
        ticketMd: TICKET_MD,
        planMd: PLAN_MD,
        scratchpadMd: SCRATCHPAD_MD,
        handoffMd: HANDOFF_MD,
        decisionMd: DECISION_MD,
      },
    ]);

    const result = await getTicketDetail(testDir, 'test-project', 'test-ticket');
    expect(result).not.toBeNull();
    expect(result!.template).toBe('feature');
    expect(result!.plan?.status).toBe('in_progress');
    expect(result!.scratchpad?.updated).toBe('2026-04-07T11:00:00Z');
    expect(result!.handoff?.handoffCount).toBe(1);
    expect(result!.decisionRecord?.decisionCount).toBe(1);
    expect(result!.availableTransitions.map((action) => action.command)).toContain('review');
  });

  it('attaches progress and comments when the files exist', async () => {
    const progressMd = `---
ticket: test-ticket
entryCount: 2
generated: "2026-04-07T10:00:00Z"
updated: "2026-04-07T14:00:00Z"
---

# Progress

## 2026-04-07T14:00:00Z

Second entry.

## 2026-04-07T12:00:00Z

First entry.
`;

    await createProjectFiles(testDir, 'test-project', PROJECT_MD, [
      {
        slug: 'test-ticket',
        ticketMd: TICKET_MD,
        progressMd,
        commentsMd: COMMENTS_MD_ONE_OPEN_QUESTION,
      },
    ]);

    const result = await getTicketDetail(testDir, 'test-project', 'test-ticket');
    expect(result).not.toBeNull();
    expect(result!.progress).not.toBeNull();
    expect(result!.progress!.entryCount).toBe(2);
    expect(result!.progress!.entries).toHaveLength(2);
    expect(result!.progress!.entries[0].timestamp).toBe('2026-04-07T14:00:00Z');
    expect(result!.comments).not.toBeNull();
    expect(result!.comments!.entries[0].type).toBe('question');
    expect(result!.comments!.entries[0].resolved).toBe(false);
  });

  it('leaves progress and comments null when the files are absent', async () => {
    await createProjectFiles(testDir, 'test-project', PROJECT_MD, [
      { slug: 'test-ticket', ticketMd: TICKET_MD },
    ]);
    const result = await getTicketDetail(testDir, 'test-project', 'test-ticket');
    expect(result).not.toBeNull();
    expect(result!.progress).toBeNull();
    expect(result!.comments).toBeNull();
  });

});

describe('listTicketsBoard id-slug folder support', () => {
  it('includes project tickets resolved by id from id-slug folders', async () => {
    const { getTicketDetailById, listTicketsBoard } = await import('../dashboard/api.js');
    const ticketId = 'BRD-1';
    await createProjectFiles(
      testDir,
      'p1',
      `---
id: p1-id
slug: p1
title: P1
created: "2026-04-20T10:00:00Z"
updated: "2026-04-20T10:00:00Z"
prefix: BRD
nextTicket: 2
---`,
      [
        {
          slug: `${ticketId}-my-board`,
          ticketMd: `---
id: ${ticketId}
slug: my-board
title: My Board Ticket
project: p1
template: feature
status: pending
priority: medium
created: "2026-04-20T10:00:00Z"
updated: "2026-04-20T10:00:00Z"
assignee: null
externalIds: []
depends_on: []
blockedReason: null
workspace:
  repository: null
  worktreePath: null
  branch: null
  parentBranch: null
tags: []
---

# My Board Ticket`,
        },
      ],
    );

    const board = await listTicketsBoard(testDir);
    const item = board.tickets.find((a) => a.id === ticketId);
    expect(item).toBeTruthy();
    expect(item!.projectSlug).toBe('p1');
    expect(item!.slug).toBe('my-board');
    expect(item!.template).toBe('feature');

    const detail = await getTicketDetailById(testDir, ticketId);
    expect(detail).not.toBeNull();
    expect(detail!.projectSlug).toBe('p1');
    expect(detail!.depends_on).toEqual([]);
    expect(detail!.template).toBe('feature');
  });

  it('returns null from getTicketDetailById for an unknown id', async () => {
    const { getTicketDetailById } = await import('../dashboard/api.js');
    const detail = await getTicketDetailById(testDir, 'no-such-id');
    expect(detail).toBeNull();
  });

  it('returns show JSON from getTicketShowById', async () => {
    const { seedMissingBuiltins } = await import('../ticket-templates/builtins.js');
    if (process.env.SYNTAUR_HOME) {
      await seedMissingBuiltins(process.env.SYNTAUR_HOME);
    }
    const ticketId = 'SHW-1';
    await createProjectFiles(
      testDir,
      'p1',
      `---
id: p1-id
slug: p1
title: P1
created: "2026-04-20T10:00:00Z"
updated: "2026-04-20T10:00:00Z"
prefix: SHW
nextTicket: 2
---`,
      [
        {
          slug: `${ticketId}-show-me`,
          ticketMd: `---
id: ${ticketId}
slug: show-me
title: Show Me
project: p1
template: quick
status: draft
priority: low
created: "2026-04-20T10:00:00Z"
updated: "2026-04-20T10:00:00Z"
depends_on: []
links: []
plan:
  file: null
  approvedDigest: null
  approvedAt: null
  approvedBy: null
tags: []
archived: false
archivedAt: null
archivedReason: null
phase: null
disposition: null
parked: false
reviewRequested: false
reworkRequested: false
implementationStarted: false
override: null
facts: {}
attestations: []
solicitations: []
firedVerdicts: []
frozenChecks: null
hold: false
gateOverrides: []
statusHistory: []
assignee: null
externalIds: []
workflow: null
blockedReason: null
---

## Objective

Show route test.
`,
        },
      ],
    );
    const { getTicketShowById } = await import('../dashboard/api.js');
    const show = await getTicketShowById(testDir, ticketId);
    expect(show).not.toBeNull();
    expect(show!.ticket.id).toBe(ticketId);
    expect(show!.ticket.stage).toBe('backlog');
    expect(show!.next).toContain('syntaur done');
  });
});

describe('referencedBy backlinks', () => {
  it('lists A under B.referencedBy when A links to B via relative path in its comments', async () => {
    const { getTicketDetail } = await import('../dashboard/api.js');
    const commentsWithLink = `---
ticket: source-a
entryCount: 1
generated: "2026-04-20T10:00:00Z"
updated: "2026-04-20T10:00:00Z"
---

# Comments

## c-1

**Recorded:** 2026-04-20T10:00:00Z
**Author:** claude-1
**Type:** note

See [target](../target-b/ticket.md) for context.
`;

    await createProjectFiles(testDir, 'test-project', PROJECT_MD, [
      {
        slug: 'source-a',
        ticketMd: TICKET_MD.replace('slug: test-ticket', 'slug: source-a').replace('id: a-123', 'id: a-111'),
        commentsMd: commentsWithLink,
      },
      {
        slug: 'target-b',
        ticketMd: TICKET_MD.replace('slug: test-ticket', 'slug: target-b').replace('id: a-123', 'id: a-222'),
      },
    ]);

    const detail = await getTicketDetail(testDir, 'test-project', 'target-b');
    expect(detail).not.toBeNull();
    const refs = detail!.referencedBy;
    const ref = refs.find((r) => r.sourceSlug === 'source-a');
    expect(ref).toBeTruthy();
    expect(ref!.mentions).toBeGreaterThanOrEqual(1);
    expect(ref!.sourceProjectSlug).toBe('test-project');
  });

  it('caps referencedBy at 50 entries', async () => {
    const { getTicketDetail } = await import('../dashboard/api.js');
    const target: Array<{ slug: string; ticketMd: string; commentsMd?: string }> = [
      {
        slug: 'target',
        ticketMd: TICKET_MD.replace('slug: test-ticket', 'slug: target').replace('id: a-123', 'id: t-id'),
      },
    ];
    for (let i = 0; i < 60; i++) {
      target.push({
        slug: `src-${i}`,
        ticketMd: TICKET_MD.replace('slug: test-ticket', `slug: src-${i}`).replace('id: a-123', `id: src-${i}`),
        commentsMd: `---
ticket: src-${i}
entryCount: 1
generated: "2026-04-20T10:00:00Z"
updated: "2026-04-20T10:00:00Z"
---

# Comments

## c-1

**Recorded:** 2026-04-20T10:00:00Z
**Author:** a
**Type:** note

link: [t](../target/ticket.md)
`,
      });
    }
    await createProjectFiles(testDir, 'test-project', PROJECT_MD, target);

    const detail = await getTicketDetail(testDir, 'test-project', 'target');
    expect(detail!.referencedBy.length).toBe(50);
  });
});

describe('listTicketsBoard', () => {
  it('returns tickets from every project with project context and transitions', async () => {
    await createProjectFiles(testDir, 'test-project', PROJECT_MD, [
      { slug: 'test-ticket', ticketMd: TICKET_MD },
    ]);
    await createProjectFiles(testDir, 'second-project', `---
id: project-2
slug: second-project
title: Second Project
archived: false
archivedAt: null
archivedReason: null
created: "2026-03-19T10:00:00Z"
updated: "2026-03-19T10:00:00Z"
tags: []
---

# Second Project`, [
      { slug: 'blocked-ticket', ticketMd: BLOCKED_TICKET_MD },
    ]);

    const result = await listTicketsBoard(testDir);

    expect(result.tickets).toHaveLength(2);
    expect(result.tickets.map((ticket) => ticket.projectSlug).sort()).toEqual([
      'second-project',
      'test-project',
    ]);
    expect(result.tickets.find((ticket) => ticket.slug === 'blocked-ticket'))
      .toMatchObject({
        projectTitle: 'Second Project',
        blockedReason: 'Waiting on API credentials',
        status: 'blocked',
      });
    expect(
      result.tickets.find((ticket) => ticket.slug === 'test-ticket')
        ?.availableTransitions.map((action) => action.command),
    ).toContain('review');
  });

  it('only includes transitions that are valid from the current status (no fallback to command name)', async () => {
    // TICKET_MD has status: in_progress. From in_progress, the valid
    // commands are `review`, `complete`, `block`, `fail` (per default
    // transitionTable). Commands like `start`, `reopen`, `unblock`,
    // `shape`, `plan-ready`, `implement` are NOT valid from in_progress
    // and previously leaked through with `targetStatus: <commandName>`.
    await createProjectFiles(testDir, 'test-project', PROJECT_MD, [
      { slug: 'test-ticket', ticketMd: TICKET_MD },
    ]);

    const result = await listTicketsBoard(testDir);
    const ticket = result.tickets.find((a) => a.slug === 'test-ticket');
    expect(ticket).toBeDefined();
    expect(ticket!.status).toBe('in_progress');

    const commands = ticket!.availableTransitions.map((a) => a.command);
    // None of the previously-bogus from-pending-only commands should leak.
    expect(commands).not.toContain('start');
    expect(commands).not.toContain('reopen');
    expect(commands).not.toContain('unblock');
  });

});

describe('externalIds on board summaries', () => {
  const EXTERNAL_IDS_TICKET_MD = `---
id: ext-1
slug: ext-ticket
title: Ext Ticket
template: feature
status: in_progress
priority: medium
created: "2026-03-20T10:00:00Z"
updated: "${RECENT_DATE}"
assignee: codex-1
externalIds:
  - system: jira
    id: ABC-7
    url: https://jira.example.com/browse/ABC-7
depends_on: []
blockedReason: null
workspace:
  repository: null
  worktreePath: null
  branch: null
  parentBranch: null
tags: []
---

# Ext Ticket`;

  it('project summary carries externalIds (projection from the parsed record)', async () => {
    await createProjectFiles(testDir, 'test-project', PROJECT_MD, [
      { slug: 'test-ticket', ticketMd: TICKET_MD },
    ]);
    const projects = await listProjects(testDir);
    expect(projects).toHaveLength(1);
    expect(projects[0].externalIds).toEqual([
      { system: 'jira', id: 'TEST-1', url: 'https://jira.example.com/browse/TEST-1' },
      { system: 'linear', id: 'ENG-9', url: null },
    ]);
  });

  it('nested ticket board summary carries externalIds', async () => {
    await createProjectFiles(testDir, 'test-project', PROJECT_MD, [
      { slug: 'ext-ticket', ticketMd: EXTERNAL_IDS_TICKET_MD },
    ]);
    const board = await listTicketsBoard(testDir);
    const item = board.tickets.find((a) => a.slug === 'ext-ticket');
    expect(item).toBeTruthy();
    expect(item!.externalIds).toEqual([
      { system: 'jira', id: 'ABC-7', url: 'https://jira.example.com/browse/ABC-7' },
    ]);
  });

});

describe('overview', () => {
  it('returns first-run onboarding state for an empty workspace', async () => {
    const result = await getOverview(testDir);
    expect(result.firstRun).toBe(true);
    expect(result.stats.activeProjects).toBe(0);
    // Every segment is empty on a fresh workspace.
    expect(result.segments.readyForReview.items).toHaveLength(0);
    expect(result.segments.blocked.items).toHaveLength(0);
    expect(result.segments.stale.items).toHaveLength(0);
    expect(result.segments.inProgress.items).toHaveLength(0);
    expect(result.hero.kind).toBe('clean');
    expect(result.hero.itemId).toBeNull();
    expect(result.recentSessions).toEqual([]);
  });

  it('builds overview stats, recent activity, and segmented attention from source files', async () => {
    await createProjectFiles(testDir, 'test-project', PROJECT_MD, [
      { slug: 'test-ticket', ticketMd: TICKET_MD, planMd: PLAN_MD },
      { slug: 'blocked-ticket', ticketMd: BLOCKED_TICKET_MD },
    ]);

    const overview = await getOverview(testDir);

    expect(overview.firstRun).toBe(false);
    expect(overview.stats.activeProjects).toBe(1);
    expect(overview.stats.inProgressTickets).toBe(1);
    expect(overview.stats.blockedTickets).toBe(1);
    expect(overview.stats.staleTickets).toBe(1);
    expect(overview.recentActivity[0].href).toContain('/projects/test-project');

    // Segments
    expect(overview.segments.inProgress.items.length).toBeGreaterThanOrEqual(1);
    expect(overview.segments.blocked.items.length).toBeGreaterThanOrEqual(1);
    expect(overview.segments.stale.items.length).toBeGreaterThanOrEqual(1);
    expect(overview.segments.blocked.items[0].severity).toBe('high');
    expect(overview.segments.blocked.items[0].segment).toBe('blocked');
    expect(overview.segments.stale.items[0].agingMs).toBeGreaterThan(0);
    expect(overview.segments.blocked.total).toBe(overview.segments.blocked.items.length);

    // Stale paging metadata
    expect(overview.segments.stale.limit).toBeGreaterThan(0);
    expect(overview.segments.stale.offset).toBe(0);
    expect(typeof overview.segments.stale.hasMore).toBe('boolean');

    // Hero rule: blocked beats stale (no review/ready_to_implement/ready_for_planning/in_progress
    // would normally beat blocked, but in_progress is also present — `in_progress` is higher
    // priority than `blocked`). Confirm hero picks one of the two and references a real id.
    expect(['in_progress', 'blocked']).toContain(overview.hero.kind);
    expect(overview.hero.itemId).toBeTruthy();
    expect(overview.hero.total).toBeGreaterThan(0);

    // Row contract: availableTransitions populated, assignee field present.
    const blocked = overview.segments.blocked.items[0];
    expect(Array.isArray(blocked.availableTransitions)).toBe(true);
    expect('assignee' in blocked).toBe(true);
  });

  it('honors staleLimit / staleOffset paging options', async () => {
    await createProjectFiles(testDir, 'test-project', PROJECT_MD, [
      { slug: 'test-ticket', ticketMd: TICKET_MD, planMd: PLAN_MD },
      { slug: 'blocked-ticket', ticketMd: BLOCKED_TICKET_MD },
    ]);

    const overview = await getOverview(testDir, { staleLimit: 1, staleOffset: 0 });
    expect(overview.segments.stale.limit).toBe(1);
    expect(overview.segments.stale.offset).toBe(0);
    expect(overview.segments.stale.items.length).toBeLessThanOrEqual(1);
  });
});

describe('overview performance', () => {
  // Regression test for the slow /api/overview fix. The original implementation
  // walked every project + every ticket sequentially via `for…await`, which
  // scaled linearly with FS round-trip latency. After parallelization
  // (`listProjectRecords` + `listTicketRecords` + `buildProjectRollup` +
  // `buildOverviewSegmentBuckets` in `src/dashboard/api.ts`), wall-clock drops
  // by ~2× on a fast tmpfs and substantially more on slower disks where
  // per-syscall latency is the dominant cost.
  //
  // Measured locally on Apple Silicon tmpfs, 60 projects × 30 tickets,
  // with `SYNTAUR_PERF_TRACE` OFF (trace adds substantial overhead). The
  // numbers below are the worst of 3 warm samples (per the assertion) under
  // full-suite parallel load via `npm test` — isolated runs are roughly 2×
  // faster but don't reflect real CI conditions.
  //   pre-fix  (npm test, full parallel suite): 1291ms warm
  //   post-fix (npm test, full parallel suite):  246ms warm
  // The under-load gap is much wider than the isolated gap because the
  // sequential `for…await` pattern competes for the event loop on every
  // await; parallelizing collapses that into a single `Promise.all` wait.
  //
  // Sanity-check revert (executed during implementation): stashing `api.ts`
  // and re-running `npm test` produces warm samples ≥ 1291ms, which exceeds
  // the ceiling below and fails the test as required.
  //
  // Ceiling: derived per the plan as max(post-fix warm) × 3 rounded up to
  // the nearest 50ms = 246 × 3 = 738 → 750ms. This catches the >1000ms
  // pre-fix regression decisively (1291ms >> 750ms) while still giving the
  // ~250ms post-fix baseline ample CI hardware headroom. See scratchpad.md
  // in the originating ticket for the full table.
  const OVERVIEW_PERF_CEILING_MS = 750;
  const PERF_FIXTURE_PROJECTS = 60;
  const PERF_FIXTURE_TICKETS_PER_PROJECT = 30;

  beforeEach(() => {
    // Reset module-level caches so each perf run starts from a known
    // cold state and does not get spuriously fast wall-clock from another
    clearStatusConfigCache();
  });

  function buildPerfProjectMd(slug: string): string {
    return `---
id: ${slug}-id
slug: ${slug}
title: ${slug}
archived: false
archivedAt: null
archivedReason: null
created: "2026-03-20T10:00:00Z"
updated: "2026-03-20T10:00:00Z"
externalIds: []
tags: []
---

# ${slug}`;
  }

  function buildPerfTicketMd(slug: string, status: string, depends_on: string[]): string {
    return `---
id: ${slug}-id
slug: ${slug}
title: ${slug}
status: ${status}
priority: medium
created: "2026-03-20T10:00:00Z"
updated: "${RECENT_DATE}"
assignee: bench
externalIds: []
depends_on: ${JSON.stringify(depends_on)}
blockedReason: null
workspace:
  repository: null
  worktreePath: null
  branch: null
  parentBranch: null
tags: []
---

# ${slug}`;
  }

  it(`returns under ${OVERVIEW_PERF_CEILING_MS}ms warm against a ${PERF_FIXTURE_PROJECTS}-project x ${PERF_FIXTURE_TICKETS_PER_PROJECT}-ticket workspace`, async () => {
    const statuses = [
      'in_progress',
      'in_progress',
      'review',
      'ready_to_implement',
      'ready_for_planning',
      'draft',
      'blocked',
      'completed',
    ];

    // Seed the fixture in parallel (this is test setup, not under measurement).
    await Promise.all(
      Array.from({ length: PERF_FIXTURE_PROJECTS }, async (_, p) => {
        const projectSlug = `proj-${p.toString().padStart(3, '0')}`;
        const projectPath = resolve(testDir, projectSlug);
        await mkdir(projectPath, { recursive: true });
        await writeFile(resolve(projectPath, 'project.md'), buildPerfProjectMd(projectSlug), 'utf-8');

        await Promise.all(
          Array.from({ length: PERF_FIXTURE_TICKETS_PER_PROJECT }, async (_, a) => {
            const slug = `asg-${a.toString().padStart(3, '0')}`;
            const status = statuses[a % statuses.length]!;
            // Every 5th ticket depends on the previous one in the same
            // project — exercises getUnmetDependencies and the new
            // dependencyStatusMap fast-path.
            const dependsIds =
              a > 0 && a % 5 === 0 ? [`asg-${(a - 1).toString().padStart(3, '0')}`] : [];
            const aDir = resolve(projectPath, 'tickets', slug);
            await mkdir(aDir, { recursive: true });
            await writeFile(
              resolve(aDir, 'ticket.md'),
              buildPerfTicketMd(slug, status, dependsIds),
              'utf-8',
            );
            // Every 4th ticket gets a comments.md with an open question —
            // exercises the parallelized countOpenQuestions in buildProjectRollup.
            if (a % 4 === 0) {
              await writeFile(resolve(aDir, 'comments.md'), COMMENTS_MD_ONE_OPEN_QUESTION, 'utf-8');
            }
          }),
        );
      }),
    );

    // Warm the FS cache and migration guard with one untimed call.
    await getOverview(testDir);

    // Measured call: take the worst of three warm runs to dampen jitter.
    const samples: number[] = [];
    for (let i = 0; i < 3; i++) {
      const start = performance.now();
      const overview = await getOverview(testDir);
      samples.push(performance.now() - start);
      // Sanity check that the fixture actually parsed.
      expect(overview.firstRun).toBe(false);
      expect(overview.recentProjects.length).toBeGreaterThan(0);
    }
    const observed = Math.max(...samples);
    expect(observed).toBeLessThan(OVERVIEW_PERF_CEILING_MS);
  }, 60_000);
});

describe('overview copy module', () => {
  it('emits segment-specific reason strings (not the generic "Ready for review.")', async () => {
    await createProjectFiles(testDir, 'test-project', PROJECT_MD, [
      { slug: 'test-ticket', ticketMd: TICKET_MD, planMd: PLAN_MD },
      { slug: 'blocked-ticket', ticketMd: BLOCKED_TICKET_MD },
    ]);
    const overview = await getOverview(testDir);

    // Inspect every row across every segment.
    const allReasons = new Set<string>();
    for (const key of Object.keys(overview.segments) as Array<keyof typeof overview.segments>) {
      for (const row of overview.segments[key].items) {
        allReasons.add(row.reason);
      }
    }

    // The legacy generic reason should NOT appear outside its segment.
    // The new readyForReview reason copy is segment-specific, not "Ready for review."
    expect(Array.from(allReasons)).not.toContain('Ready for review.');
  });
});

describe('help and editable documents', () => {
  it('returns the structured help model with only implemented commands', async () => {
    const help = await getHelp();
    const commandNames = help.commands.map((command) => command.command);

    expect(commandNames).toContain('syntaur dashboard');
    expect(commandNames).toContain('syntaur project new');
    expect(commandNames).not.toContain('syntaur rebuild');
    expect(help.coreConcepts.some((concept) => concept.term === 'Project')).toBe(true);
  });

  it('returns editable document payloads for project and ticket files', async () => {
    await createProjectFiles(testDir, 'test-project', PROJECT_MD, [
      { slug: 'test-ticket', ticketMd: TICKET_MD },
    ]);

    const projectDoc = await getEditableDocument(testDir, 'project', 'test-project');
    const ticketDoc = await getEditableDocument(
      testDir,
      'ticket',
      'test-project',
      'test-ticket',
    );

    expect(projectDoc?.documentType).toBe('project');
    expect(projectDoc?.content).toContain('Test Project');
    expect(ticketDoc?.documentType).toBe('ticket');
    expect(ticketDoc?.content).toContain('Test Ticket');
  });
});


describe('POST /api/agent-sessions', () => {
  let server: Server;
  let port: number;
  let dbDir: string;

  beforeEach(async () => {
    resetSessionDb();
    dbDir = await mkdtemp(join(tmpdir(), 'syntaur-apidb-'));
    initSessionDb(resolve(dbDir, 'syntaur.db'));

    const app = express();
    app.use(express.json());
    app.use('/api/agent-sessions', createAgentSessionsRouter(dbDir));

    await new Promise<void>((ready) => {
      server = app.listen(0, () => ready());
    });
    port = (server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    await new Promise<void>((done) => server.close(() => done()));
    closeSessionDb();
    await rm(dbDir, { recursive: true, force: true });
  });

  it('returns 400 when sessionId is missing', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/agent-sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent: 'claude' }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/sessionId/);
  });

  it('returns 400 when agent is missing', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/agent-sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: 'abc' }),
    });
    expect(res.status).toBe(400);
  });

  it('accepts sessionId + transcriptPath and returns 201', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/agent-sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agent: 'claude',
        sessionId: 'real-id-123',
        transcriptPath: '/tmp/transcript.jsonl',
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.sessionId).toBe('real-id-123');

    const listRes = await fetch(`http://127.0.0.1:${port}/api/agent-sessions`);
    const listBody = await listRes.json();
    expect(listBody.sessions).toHaveLength(1);
    expect(listBody.sessions[0].sessionId).toBe('real-id-123');
    expect(listBody.sessions[0].transcriptPath).toBe('/tmp/transcript.jsonl');
  });

  it('re-registering without path does not clobber the existing stored path', async () => {
    // First registration carries a real path.
    await fetch(`http://127.0.0.1:${port}/api/agent-sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agent: 'claude',
        sessionId: 'sid-upsert',
        path: '/real/cwd',
      }),
    });

    // Second registration omits path (SessionStart hook case).
    const res2 = await fetch(`http://127.0.0.1:${port}/api/agent-sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agent: 'claude',
        sessionId: 'sid-upsert',
        transcriptPath: '/tmp/transcript.jsonl',
      }),
    });
    expect(res2.status).toBe(201);

    const listRes = await fetch(`http://127.0.0.1:${port}/api/agent-sessions`);
    const listBody = await listRes.json();
    const row = listBody.sessions.find((s: any) => s.sessionId === 'sid-upsert');
    expect(row).toBeTruthy();
    expect(row.path).toBe('/real/cwd'); // preserved, not overwritten with ''
    expect(row.transcriptPath).toBe('/tmp/transcript.jsonl'); // enriched
  });

  it('list response reports isLive per row (status === active)', async () => {
    await fetch(`http://127.0.0.1:${port}/api/agent-sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agent: 'claude',
        sessionId: 'sid-enrich-claude',
        path: '/tmp',
      }),
    });
    await fetch(`http://127.0.0.1:${port}/api/agent-sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agent: 'mystery-agent', // not in BUILTIN_AGENTS or config
        sessionId: 'sid-enrich-mystery',
        path: '/tmp',
      }),
    });

    const listRes = await fetch(`http://127.0.0.1:${port}/api/agent-sessions`);
    const listBody = await listRes.json();

    // `isLive` is now `status === 'active'` for every row, whatever the agent
    // is — the pid / transcript-mtime heuristics and the resume/fork capability
    // flags went with the terminal launch stack.
    const claude = listBody.sessions.find((s: any) => s.sessionId === 'sid-enrich-claude');
    expect(claude.isLive).toBe(claude.status === 'active');
    expect(claude.resumeSupported).toBeUndefined();
    expect(claude.forkSupported).toBeUndefined();

    const mystery = listBody.sessions.find((s: any) => s.sessionId === 'sid-enrich-mystery');
    expect(mystery.isLive).toBe(mystery.status === 'active');
  });

});

describe('PATCH /api/agent-sessions/:sessionId (terminal-only)', () => {
  let server: Server;
  let port: number;
  let dbDir: string;

  beforeEach(async () => {
    resetSessionDb();
    dbDir = await mkdtemp(join(tmpdir(), 'syntaur-apidb-patch-'));
    initSessionDb(resolve(dbDir, 'syntaur.db'));

    const app = express();
    app.use(express.json());
    app.use('/api/agent-sessions', createAgentSessionsRouter(dbDir));

    await new Promise<void>((ready) => {
      server = app.listen(0, () => ready());
    });
    port = (server.address() as AddressInfo).port;

    await fetch(`http://127.0.0.1:${port}/api/agent-sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent: 'claude', sessionId: 'sid-patch-1', path: '/tmp' }),
    });
  });

  afterEach(async () => {
    await new Promise<void>((done) => server.close(() => done()));
    closeSessionDb();
    await rm(dbDir, { recursive: true, force: true });
  });

  it('returns 200 and flips status to stopped', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/agent-sessions/sid-patch-1`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'stopped' }),
    });
    expect(res.status).toBe(200);

    const listRes = await fetch(`http://127.0.0.1:${port}/api/agent-sessions`);
    const listBody = await listRes.json();
    const row = listBody.sessions.find((s: any) => s.sessionId === 'sid-patch-1');
    expect(row.status).toBe('stopped');
    expect(row.isLive).toBe(false); // status override → false
  });

  it('returns 200 and flips status to completed', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/agent-sessions/sid-patch-1`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'completed' }),
    });
    expect(res.status).toBe(200);
  });

  it('returns 400 when status is non-terminal (active)', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/agent-sessions/sid-patch-1`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'active' }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/stopped, completed/);
  });

  it('returns 400 when status is missing', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/agent-sessions/sid-patch-1`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it('returns 404 when sessionId is unknown', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/agent-sessions/does-not-exist`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'stopped' }),
    });
    expect(res.status).toBe(404);
  });

  it('PATCH /:sessionId/status (non-terminal, internal route) still works alongside the new endpoint', async () => {
    // Express precedence: longer-prefix /:sessionId/status wins over /:sessionId
    // for the existing route, so the more lenient internal flow still works.
    const res = await fetch(
      `http://127.0.0.1:${port}/api/agent-sessions/sid-patch-1/status`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'active' }),
      },
    );
    expect(res.status).toBe(200);
  });

  it('returns 409 when reviving a COMPLETED session to active (no resurrection)', async () => {
    // Mark sid-patch-1 completed via the terminal route…
    const done = await fetch(`http://127.0.0.1:${port}/api/agent-sessions/sid-patch-1`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'completed' }),
    });
    expect(done.status).toBe(200);

    // …then attempt to revive it to active via the /status route → refused.
    const res = await fetch(
      `http://127.0.0.1:${port}/api/agent-sessions/sid-patch-1/status`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'active' }),
      },
    );
    expect(res.status).toBe(409);

    const listRes = await fetch(`http://127.0.0.1:${port}/api/agent-sessions`);
    const listBody = await listRes.json();
    const row = listBody.sessions.find((s: any) => s.sessionId === 'sid-patch-1');
    expect(row.status).toBe('completed');
  });
});

describe('archive hiding + cascade + listArchived + migration', () => {
  const RECENT = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString().replace(/\.\d+Z$/, 'Z');

  function projectMd(slug: string, opts: { archived?: boolean; statusOverride?: string } = {}): string {
    const so = opts.statusOverride ? `statusOverride: ${opts.statusOverride}\n` : '';
    return `---\nid: ${slug}-id\nslug: ${slug}\ntitle: ${slug}\narchived: ${opts.archived ? 'true' : 'false'}\narchivedAt: null\narchivedReason: null\n${so}created: "2026-03-20T10:00:00Z"\nupdated: "2026-03-20T10:00:00Z"\ntags: []\n---\n\n# ${slug}`;
  }

  function asgMd(id: string, slug: string, opts: { archived?: boolean; status?: string } = {}): string {
    const archived = opts.archived ? 'true' : 'false';
    const archivedAt = opts.archived ? '"2026-05-31T00:00:00Z"' : 'null';
    return `---\nid: ${id}\nslug: ${slug}\ntitle: ${slug}\nstatus: ${opts.status ?? 'in_progress'}\npriority: medium\ncreated: "2026-03-20T10:00:00Z"\nupdated: "${RECENT}"\nassignee: null\nexternalIds: []\ndepends_on: []\nblockedReason: null\nworkspace:\n  repository: null\n  worktreePath: null\n  branch: null\n  parentBranch: null\ntags: []\narchived: ${archived}\narchivedAt: ${archivedAt}\narchivedReason: null\n---\n\nBody`;
  }

  async function writeStandalone(dir: string, id: string, slug: string, archived: boolean): Promise<void> {
    const adir = resolve(dir, id);
    await mkdir(adir, { recursive: true });
    await writeFile(resolve(adir, 'ticket.md'),
      `---\nid: ${id}\nslug: ${slug}\ntitle: ${slug}\nstatus: in_progress\npriority: medium\ncreated: "2026-03-20T10:00:00Z"\nupdated: "${RECENT}"\nassignee: null\nexternalIds: []\ndepends_on: []\nblockedReason: null\nworkspace:\n  repository: null\n  worktreePath: null\n  branch: null\n  parentBranch: null\ntags: []\narchived: ${archived ? 'true' : 'false'}\narchivedAt: ${archived ? '"2026-05-31T00:00:00Z"' : 'null'}\narchivedReason: null\n---\n\nBody`,
      'utf-8');
  }

  // Project A: active, with one active + one individually-archived ticket.
  // Project B: archived, with two tickets (one individually archived).
  async function seed(): Promise<void> {
    clearStatusConfigCache();
    await createProjectFiles(testDir, 'proj-a', projectMd('proj-a'), [
      { slug: 'a-active', ticketMd: asgMd('a-active-id', 'a-active') },
      { slug: 'a-arch', ticketMd: asgMd('a-arch-id', 'a-arch', { archived: true }) },
    ]);
    await createProjectFiles(testDir, 'proj-b', projectMd('proj-b', { archived: true }), [
      { slug: 'b1', ticketMd: asgMd('b1-id', 'b1') },
      { slug: 'b2', ticketMd: asgMd('b2-id', 'b2', { archived: true }) },
    ]);
  }

  it('listProjects excludes archived projects', async () => {
    await seed();
    const projects = await listProjects(testDir);
    expect(projects.map((p) => p.slug).sort()).toEqual(['proj-a']);
  });

  it('listTicketsBoard default-excludes archived + cascade-hides archived-project children', async () => {
    await seed();
    const board = await listTicketsBoard(testDir);
    const slugs = board.tickets.map((a) => a.slug).sort();
    // a-active only. a-arch hidden; b1/b2 cascade-hidden.
    expect(slugs).toEqual(['a-active']);
  });

  it("listTicketsBoard { archived: 'only' } returns individually-archived only (no cascade children)", async () => {
    await seed();
    const board = await listTicketsBoard(testDir, { archived: 'only' });
    const slugs = board.tickets.map((a) => a.slug).sort();
    // a-arch (individually) + b2 (individually, even under archived project).
    // b1 is NOT included (it is cascade-hidden, not individually archived).
    expect(slugs).toEqual(['a-arch', 'b2']);
  });

  it('listArchived returns archived projects with children + individually-archived (no double-listing)', async () => {
    const { listArchived } = await import('../dashboard/api.js');
    await seed();
    const archived = await listArchived(testDir);

    expect(archived.projects.map((p) => p.slug)).toEqual(['proj-b']);
    expect(archived.projects[0].tickets.map((a) => a.slug).sort()).toEqual(['b1', 'b2']);

    // Top-level archived tickets: a-arch (parent active).
    // b2 must NOT appear here (it lives under archived proj-b).
    expect(archived.tickets.map((a) => a.slug).sort()).toEqual(['a-arch']);
  });

  it('buildProjectRollup progress.total excludes archived children', async () => {
    await seed();
    const detail = await getProjectDetail(testDir, 'proj-a');
    expect(detail).not.toBeNull();
    // getProjectDetail still returns ALL tickets...
    expect(detail!.tickets.length).toBe(2);
    // ...but progress.total counts only the active one.
    expect(detail!.progress.total).toBe(1);
  });

  it('getOverview excludes archived projects + individually-archived from stats', async () => {
    await seed();
    const overview = await getOverview(testDir);
    // proj-b is archived → not counted as an active project.
    expect(overview.recentProjects.map((p) => p.slug)).toEqual(['proj-a']);
    // in-progress count: only a-active (a-arch hidden, proj-b cascade-hidden).
    expect(overview.stats.inProgressTickets).toBe(1);
  });

  it('migrates legacy statusOverride:archived projects to the real flag on read', async () => {
    const { listArchived } = await import('../dashboard/api.js');
    await createProjectFiles(testDir, 'legacy', projectMd('legacy', { statusOverride: 'archived' }), [
      { slug: 'l1', ticketMd: asgMd('l1-id', 'l1') },
    ]);
    // First read triggers the migration.
    const projects = await listProjects(testDir);
    expect(projects.map((p) => p.slug)).not.toContain('legacy');

    const onDisk = await readFile(resolve(testDir, 'legacy', 'project.md'), 'utf-8');
    expect(onDisk).toContain('archived: true');
    expect(onDisk).not.toContain('statusOverride: archived');

    const archived = await listArchived(testDir);
    expect(archived.projects.map((p) => p.slug)).toContain('legacy');
  });

  it('migration preserves an existing archivedAt when reconciling statusOverride:archived', async () => {
    const existing = '2025-01-01T00:00:00Z';
    const md = `---\nid: legacy2-id\nslug: legacy2\ntitle: legacy2\narchived: false\narchivedAt: "${existing}"\narchivedReason: null\nstatusOverride: archived\ncreated: "2026-03-20T10:00:00Z"\nupdated: "2026-03-20T10:00:00Z"\ntags: []\n---\n\n# legacy2`;
    await createProjectFiles(testDir, 'legacy2', md, []);
    await listProjects(testDir); // triggers migration
    const onDisk = await readFile(resolve(testDir, 'legacy2', 'project.md'), 'utf-8');
    expect(onDisk).toContain('archived: true');
    expect(onDisk).toContain(`archivedAt: "${existing}"`); // preserved, not re-stamped
    expect(onDisk).not.toContain('statusOverride: archived');
  });

  it('restoring an archived project unhides cascade children but keeps individually-archived ones hidden', async () => {
    const { invalidateRecordsCache } = await import('../dashboard/api.js');
    await seed();

    // While proj-b is archived, both its children are hidden from the board.
    let board = await listTicketsBoard(testDir);
    expect(board.tickets.map((a) => a.slug)).not.toContain('b1');
    expect(board.tickets.map((a) => a.slug)).not.toContain('b2');

    // Restore proj-b (clear its archive flag); children are untouched on disk.
    await writeFile(
      resolve(testDir, 'proj-b', 'project.md'),
      projectMd('proj-b', { archived: false }),
      'utf-8',
    );
    invalidateRecordsCache();

    board = await listTicketsBoard(testDir);
    const slugs = board.tickets.map((a) => a.slug);
    expect(slugs).toContain('b1'); // cascade-hidden child reappears
    expect(slugs).not.toContain('b2'); // individually-archived child stays hidden
  });
});

// ── AC5/AC6: board items carry a computed facts block (terminal items too) ────
describe('board payload — facts block + terminal completedAt (AC5/AC6)', () => {
  // A completed ticket with a statusHistory entry transitioning INTO the
  // terminal `completed` status → deriveStatusVirtuals materializes completedAt.
  const COMPLETED_MD = `---
id: done-1
slug: done-task
title: Done Task
template: feature
status: completed
priority: medium
created: "2026-04-01T10:00:00Z"
updated: "2026-04-01T12:00:00Z"
assignee: claude
externalIds: []
depends_on: []
blockedReason: null
workspace:
  repository: null
  worktreePath: null
  branch: null
  parentBranch: null
tags: []
statusHistory:
  - at: "2026-04-01T10:00:00Z"
    from: null
    to: in_progress
    command: create
    by: human
  - at: "2026-04-01T12:00:00Z"
    from: in_progress
    to: completed
    command: complete
    by: human
---

# Done Task

## Objective

Ship it.

## Acceptance Criteria

- [x] Done
`;

  it('a non-terminal board item carries a facts block', async () => {
    await createProjectFiles(testDir, 'test-project', PROJECT_MD, [
      { slug: 'test-ticket', ticketMd: TICKET_MD, planMd: PLAN_MD },
    ]);
    const board = await listTicketsBoard(testDir);
    const item = board.tickets.find((a) => a.slug === 'test-ticket');
    expect(item).toBeDefined();
    // facts are computed (not nulled) and include the built-in objective facts.
    expect(item!.facts).toBeDefined();
    expect(typeof item!.facts!.planExists).toBe('boolean');
    expect('hasRealObjective' in item!.facts!).toBe(true);
  });

  it('a TERMINAL item still has completedAt populated + a facts block, and matches completedAt < -1mo', async () => {
    await createProjectFiles(testDir, 'test-project', PROJECT_MD, [
      { slug: 'done-task', ticketMd: COMPLETED_MD },
    ]);
    const board = await listTicketsBoard(testDir);
    const item = board.tickets.find((a) => a.slug === 'done-task');
    expect(item).toBeDefined();
    expect(item!.status).toBe('completed');
    // Facts are computed for terminal items, not nulled.
    expect(item!.facts).toBeDefined();
    // completedAt is the `at` of the transition INTO the terminal status.
    expect(item!.completedAt).toBe('2026-04-01T12:00:00Z');

    // The materialized QueryItem matches `completedAt < -1mo` with a now well
    // after the completion date (fixed, never wall-clock).
    const NOW = Date.parse('2026-06-09T12:00:00Z');
    const { query: compiled } = compileQuery('completedAt < -1mo');
    expect(compiled).not.toBeNull();
    const q = boardItemToQueryItem(item!);
    expect(compiled!.predicate(q, { now: NOW })).toBe(true);
  });
});

describe('GET /api/tickets/:id/events', () => {
  let sandbox: string;
  let projectsDir: string;
    let server: Server;
  let baseUrl: string;
  let originalEnv: string | undefined;

  beforeEach(async () => {
    sandbox = await mkdtemp(join(tmpdir(), 'syntaur-api-events-'));
    projectsDir = resolve(sandbox, 'projects');
      await mkdir(projectsDir, { recursive: true });
      originalEnv = process.env.SYNTAUR_HOME;
    process.env.SYNTAUR_HOME = sandbox;

    const app = express();
    const { createEventsRouter } = await import('../dashboard/api-events.js');
    app.use('/api', createEventsRouter(projectsDir));

    await new Promise<void>((res) => {
      server = app.listen(0, '127.0.0.1', () => res());
    });
    const addr = server.address() as import('node:net').AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((res) => server.close(() => res()));
    const { closeEventsDb, resetEventsDb } = await import('../db/events-db.js');
    closeEventsDb();
    resetEventsDb();
    if (originalEnv === undefined) delete process.env.SYNTAUR_HOME;
    else process.env.SYNTAUR_HOME = originalEnv;
    await rm(sandbox, { recursive: true, force: true });
  });

  it('returns recorded events for a project-nested ticket resolved by id', async () => {
    const ticketId = 'EVT-1';
    const projectDir = resolve(projectsDir, 'p1', 'tickets', `${ticketId}-a1`);
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      resolve(projectDir, 'ticket.md'),
      `---\nid: ${ticketId}\nslug: a1\ntitle: a1\nstatus: pending\n---\n`,
      'utf-8',
    );

    const { initEventsDb, recordEvent } = await import('../db/events-db.js');
    initEventsDb();
    recordEvent({
      ticketId,
      type: 'status-change',
      actor: 'human',
      at: '2026-05-21T12:00:00.000Z',
      details: { from: null, to: 'pending', command: 'create' },
    });

    const res = await fetch(`${baseUrl}/api/tickets/${ticketId}/events`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.events).toHaveLength(1);
    expect(body.events[0].type).toBe('status-change');
  });
});
