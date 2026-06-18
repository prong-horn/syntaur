import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { collectStaleCandidates } from '../dashboard/api.js';

let testDir: string;
let projectsDir: string;

const PROJECT_MD = `---\nslug: p1\ntitle: P1\nstatus: active\n---\n# P1`;

// Blocked for months (old statusHistory) → contradiction-stale via blocked_aging.
const STALE_MD = `---
id: stale-1
slug: stale-one
title: Stale One
status: blocked
priority: medium
created: "2026-01-01T10:00:00Z"
updated: "2026-01-05T10:00:00Z"
assignee: codex
externalIds: []
dependsOn: []
blockedReason: waiting on infra
disposition: blocked
statusHistory:
  - at: "2026-01-05T10:00:00Z"
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

# Stale One`;

// Fresh draft → not stale.
const FRESH_MD = `---
id: fresh-1
slug: fresh-one
title: Fresh One
status: draft
priority: medium
created: "2026-06-17T10:00:00Z"
updated: "2026-06-17T10:00:00Z"
assignee: null
externalIds: []
dependsOn: []
blockedReason: null
workspace:
  repository: null
  worktreePath: null
  branch: null
  parentBranch: null
tags: []
---

# Fresh One`;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'syntaur-collect-'));
  projectsDir = resolve(testDir, 'projects');
  const aDir = resolve(projectsDir, 'p1', 'assignments');
  await mkdir(resolve(aDir, 'stale-one'), { recursive: true });
  await mkdir(resolve(aDir, 'fresh-one'), { recursive: true });
  await writeFile(resolve(projectsDir, 'p1', 'project.md'), PROJECT_MD);
  await writeFile(resolve(aDir, 'stale-one', 'assignment.md'), STALE_MD);
  await writeFile(resolve(aDir, 'fresh-one', 'assignment.md'), FRESH_MD);
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

describe('collectStaleCandidates', () => {
  it('returns only contradiction-stale assignments, keyed by id with reasons', async () => {
    const candidates = await collectStaleCandidates(projectsDir, resolve(testDir, 'standalone'));
    const ids = candidates.map((c) => c.assignmentId);
    expect(ids).toContain('stale-1');
    expect(ids).not.toContain('fresh-1');
    const stale = candidates.find((c) => c.assignmentId === 'stale-1')!;
    expect(stale.projectSlug).toBe('p1');
    expect(stale.reasons.map((r) => r.kind)).toContain('blocked_aging');
  });
});
