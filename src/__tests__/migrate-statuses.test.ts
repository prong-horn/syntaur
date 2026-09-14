import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { migrateStatusesCommand } from '../commands/migrate-statuses.js';
import { parseTicketFrontmatter } from '../lifecycle/frontmatter.js';

let home: string;
let projectsDir: string;
let prevHome: string | undefined;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'syntaur-migrate-statuses-'));
  projectsDir = resolve(home, 'projects');
  prevHome = process.env.SYNTAUR_HOME;
  process.env.SYNTAUR_HOME = home;
});

afterEach(async () => {
  if (prevHome === undefined) delete process.env.SYNTAUR_HOME;
  else process.env.SYNTAUR_HOME = prevHome;
  await rm(home, { recursive: true, force: true });
});

// A `pending` ticket with a fleshed-out Objective + at least one real
// acceptance criterion — the predicate migrate-statuses uses to promote.
function promotableMd(slug: string): string {
  return `---
id: ${slug}-id
slug: ${slug}
title: "${slug}"
status: pending
priority: medium
created: "2026-01-01T00:00:00Z"
updated: "2026-01-01T00:00:00Z"
assignee: null
externalIds: []
depends_on: []
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

## Objective

Build the thing properly so it can ship.

## Acceptance Criteria

- [ ] The thing does the thing
`;
}

describe('migrateStatusesCommand — statusHistory', () => {
  it('promote appends a statusHistory entry (command: promote)', async () => {
    const dir = resolve(projectsDir, 'p1', 'tickets', 'a1');
    await mkdir(dir, { recursive: true });
    const path = resolve(dir, 'ticket.md');
    await writeFile(path, promotableMd('a1'), 'utf-8');

    await migrateStatusesCommand({ dir: projectsDir, apply: true });

    const fm = parseTicketFrontmatter(await readFile(path, 'utf-8'));
    expect(fm.status).toBe('ready_for_planning');
    expect(fm.statusHistory).toHaveLength(1);
    expect(fm.statusHistory[0]).toMatchObject({
      from: 'pending',
      to: 'ready_for_planning',
      command: 'promote',
      by: null,
    });
  });
});
