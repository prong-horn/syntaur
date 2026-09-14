import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { collectStaleCandidates } from '../dashboard/api.js';
import { closeEventsDb, initEventsDb, resetEventsDb } from '../db/events-db.js';
import { useHermeticSyntaurHome } from './hermetic-root.js';

useHermeticSyntaurHome();

let testDir: string;
let projectsDir: string;

const PROJECT_MD = `---\nslug: p1\ntitle: P1\nstatus: active\n---\n# P1`;

// Blocked for months (old statusHistory) → contradiction-stale via blocked_aging.
const STALE_MD = `---
id: stale-1
slug: stale-one
title: Stale One
status: in_progress
priority: medium
created: "2026-01-01T10:00:00Z"
updated: "2026-01-05T10:00:00Z"
assignee: codex
externalIds: []
depends_on: []
blocked: waiting on infra
parked: null
workspace:
  repository: null
  worktree: null
  branch: null
  parentBranch: null
tags: []
---

# Stale One`;

// Fresh draft → not stale.
const FRESH_MD = `---
id: fresh-1
slug: fresh-one
title: Fresh One
status: backlog
priority: medium
created: "2026-06-17T10:00:00Z"
updated: "2026-06-17T10:00:00Z"
assignee: null
externalIds: []
depends_on: []
blocked: null
parked: null
workspace:
  repository: null
  worktree: null
  branch: null
  parentBranch: null
tags: []
---

# Fresh One`;

beforeEach(async () => {
  closeEventsDb();
  resetEventsDb();
  testDir = await mkdtemp(join(tmpdir(), 'syntaur-collect-'));
  initEventsDb(join(testDir, 'syntaur.db'));
  projectsDir = resolve(testDir, 'projects');
  const aDir = resolve(projectsDir, 'p1', 'tickets');
  await mkdir(resolve(aDir, 'stale-one'), { recursive: true });
  await mkdir(resolve(aDir, 'fresh-one'), { recursive: true });
  await writeFile(resolve(projectsDir, 'p1', 'project.md'), PROJECT_MD);
  await writeFile(resolve(aDir, 'stale-one', 'ticket.md'), STALE_MD);
  await writeFile(resolve(aDir, 'fresh-one', 'ticket.md'), FRESH_MD);
});

afterEach(async () => {
  closeEventsDb();
  resetEventsDb();
  await rm(testDir, { recursive: true, force: true });
});

describe('collectStaleCandidates', () => {
  it('returns only contradiction-stale tickets, keyed by id with reasons', async () => {
    const candidates = await collectStaleCandidates(projectsDir);
    const ids = candidates.map((c) => c.ticketId);
    expect(ids).toContain('stale-1');
    expect(ids).not.toContain('fresh-1');
    const stale = candidates.find((c) => c.ticketId === 'stale-1')!;
    expect(stale.projectSlug).toBe('p1');
    expect(stale.reasons.map((r) => r.kind)).toContain('blocked_aging');
  });
});
