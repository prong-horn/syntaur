/**
 * Staying board/project reader performance bench. Gated by
 * SYNTAUR_PERF_BENCH=1 so it does not run in normal CI.
 *
 *   SYNTAUR_PERF_BENCH=1 \
 *     npx vitest run src/__tests__/perf-overview.test.ts --reporter=verbose
 *
 * Uses synthetic projects only.
 */
import { describe, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  listProjects,
  listTicketsBoard,
} from '../dashboard/api.js';

const ENABLED = process.env.SYNTAUR_PERF_BENCH === '1';

const NOW = new Date();
const RECENT = new Date(NOW.getTime() - 2 * 24 * 60 * 60 * 1000)
  .toISOString()
  .replace(/\.\d+Z$/, 'Z');

function projectMd(slug: string): string {
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

function ticketMd(slug: string, status: string, depends_on: string[] = []): string {
  return `---
id: ${slug}-id
slug: ${slug}
title: ${slug}
template: feature
status: ${status}
priority: medium
created: "2026-03-20T10:00:00Z"
updated: "${RECENT}"
assignee: bench
externalIds: []
depends_on: ${JSON.stringify(depends_on)}
blocked: null
workspace:
  repository: null
  worktree: null
  branch: null
  parentBranch: null
tags: []
---

# ${slug}`;
}

const JOURNAL_OPEN_QUESTION = `---
purpose: journal
---

# Journal

## 2026-04-07T10:00:00Z · question · bench

Open question.
`;

async function seedSyntheticWorkspace(
  projectsDir: string,
  projects: number,
  ticketsPerProject: number,
): Promise<void> {
  const statuses = [
    'in_progress',
    'in_progress',
    'in_progress',
    'review',
    'ready',
    'planning',
    'backlog',
    'done',
    'dropped',
  ];

  for (let p = 0; p < projects; p++) {
    const projectSlug = `proj-${p.toString().padStart(3, '0')}`;
    const projectPath = resolve(projectsDir, projectSlug);
    await mkdir(projectPath, { recursive: true });
    await writeFile(resolve(projectPath, 'project.md'), projectMd(projectSlug), 'utf-8');

    for (let a = 0; a < ticketsPerProject; a++) {
      const slug = `asg-${a.toString().padStart(3, '0')}`;
      const status = statuses[a % statuses.length]!;
      const dependsIds =
        a > 0 && a % 5 === 0 ? [`asg-${(a - 1).toString().padStart(3, '0')}`] : [];
      const aDir = resolve(projectPath, 'tickets', slug);
      await mkdir(aDir, { recursive: true });
      await writeFile(
        resolve(aDir, 'ticket.md'),
        ticketMd(slug, status, dependsIds),
        'utf-8',
      );
      if (a % 4 === 0) {
        await writeFile(resolve(aDir, 'journal.md'), JOURNAL_OPEN_QUESTION, 'utf-8');
      }
    }
  }
}

async function runOnce(label: string, projectsDir: string): Promise<number> {
  const start = performance.now();
  const [projects, board] = await Promise.all([listProjects(projectsDir), listTicketsBoard(projectsDir)]);
  const ms = performance.now() - start;
  // eslint-disable-next-line no-console
  console.log(
    `[perf-bench:${label}] total=${ms.toFixed(1)}ms projects=${projects.length} tickets=${board.tickets.length}`,
  );
  return ms;
}


describe.skipIf(!ENABLED)('board/project reader synthetic 60x30', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'syntaur-perf-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('cold + warm + warm against 60 projects x 30 tickets', async () => {
    await seedSyntheticWorkspace(dir, 60, 30);
    const cold = await runOnce('synthetic-cold', dir);
    const warm1 = await runOnce('synthetic-warm-1', dir);
    const warm2 = await runOnce('synthetic-warm-2', dir);
    // eslint-disable-next-line no-console
    console.log(
      `[perf-bench:synthetic-summary] cold=${cold.toFixed(1)}ms warm1=${warm1.toFixed(1)}ms warm2=${warm2.toFixed(1)}ms`,
    );
  }, 120_000);
});
