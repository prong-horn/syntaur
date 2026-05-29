/**
 * Overview performance bench. Gated by SYNTAUR_PERF_BENCH=1 so it does not
 * run in normal CI. Combine with SYNTAUR_PERF_TRACE=1 to see per-phase
 * JSON traces emitted by getOverview itself.
 *
 *   SYNTAUR_PERF_BENCH=1 SYNTAUR_PERF_TRACE=1 \
 *     npx vitest run src/__tests__/perf-overview.test.ts --reporter=verbose
 *
 * Add SYNTAUR_PERF_BENCH_REAL=1 to also bench against the live ~/.syntaur
 * workspace, including the FULL startup path (overview with serversDir +
 * assignmentsDir, a /api/servers GET, and the concurrent startup request set).
 * This is the command to run on the slow work Mac:
 *
 *   SYNTAUR_PERF_BENCH=1 SYNTAUR_PERF_BENCH_REAL=1 SYNTAUR_PERF_TRACE=1 \
 *     npx vitest run src/__tests__/perf-overview.test.ts --reporter=verbose
 */
import { describe, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { homedir } from 'node:os';

import {
  getOverview,
  listProjects,
  listAssignmentsBoard,
  listWorkspaces,
} from '../dashboard/api.js';
import { scanAllSessions } from '../dashboard/scanner.js';
import {
  assignmentsDir as getAssignmentsDir,
  serversDir as getServersDir,
} from '../utils/paths.js';

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

function assignmentMd(slug: string, status: string, dependsOn: string[] = []): string {
  return `---
id: ${slug}-id
slug: ${slug}
title: ${slug}
status: ${status}
priority: medium
created: "2026-03-20T10:00:00Z"
updated: "${RECENT}"
assignee: bench
externalIds: []
dependsOn: ${JSON.stringify(dependsOn)}
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

const COMMENTS_OPEN_QUESTION = `---
assignment: a
entryCount: 1
generated: "2026-04-07T10:00:00Z"
updated: "2026-04-07T10:00:00Z"
---

# Comments

## q-1

**Recorded:** 2026-04-07T10:00:00Z
**Author:** bench
**Type:** question
**Resolved:** false

Open question.
`;

async function seedSyntheticWorkspace(
  projectsDir: string,
  projects: number,
  assignmentsPerProject: number,
): Promise<void> {
  const statuses = [
    'in_progress',
    'in_progress',
    'in_progress',
    'review',
    'ready_to_implement',
    'ready_for_planning',
    'draft',
    'blocked',
    'completed',
  ];

  for (let p = 0; p < projects; p++) {
    const projectSlug = `proj-${p.toString().padStart(3, '0')}`;
    const projectPath = resolve(projectsDir, projectSlug);
    await mkdir(projectPath, { recursive: true });
    await writeFile(resolve(projectPath, 'project.md'), projectMd(projectSlug), 'utf-8');

    for (let a = 0; a < assignmentsPerProject; a++) {
      const slug = `asg-${a.toString().padStart(3, '0')}`;
      const status = statuses[a % statuses.length]!;
      // Every 5th assignment depends on the previous one in the same project
      // to exercise getUnmetDependencies on the hot path.
      const dependsOn =
        a > 0 && a % 5 === 0 ? [`asg-${(a - 1).toString().padStart(3, '0')}`] : [];
      const aDir = resolve(projectPath, 'assignments', slug);
      await mkdir(aDir, { recursive: true });
      await writeFile(
        resolve(aDir, 'assignment.md'),
        assignmentMd(slug, status, dependsOn),
        'utf-8',
      );
      // Every 4th assignment gets a comments.md with an open question
      // so countOpenQuestions reads more than empty files.
      if (a % 4 === 0) {
        await writeFile(resolve(aDir, 'comments.md'), COMMENTS_OPEN_QUESTION, 'utf-8');
      }
    }
  }
}

async function runOnce(label: string, projectsDir: string): Promise<number> {
  const start = performance.now();
  const overview = await getOverview(projectsDir);
  const ms = performance.now() - start;
  // eslint-disable-next-line no-console
  console.log(
    `[perf-bench:${label}] total=${ms.toFixed(1)}ms projects=${overview.recentProjects.length} firstRun=${overview.firstRun}`,
  );
  return ms;
}

// Exercises the FULL overview args (serversDir + assignmentsDir) the dashboard
// actually passes — this is the path that triggers the tmux scan, which
// `runOnce` (projectsDir-only) never measures.
async function runFullOverview(
  label: string,
  projectsDir: string,
  serversDir: string,
  assignmentsDir: string,
): Promise<number> {
  const start = performance.now();
  const overview = await getOverview(projectsDir, serversDir, assignmentsDir);
  const ms = performance.now() - start;
  // eslint-disable-next-line no-console
  console.log(
    `[perf-bench:${label}] total=${ms.toFixed(1)}ms projects=${overview.recentProjects.length} serverStats=${overview.serverStats ? 'present' : 'absent'}`,
  );
  return ms;
}

// Measures a single /api/servers GET the way the route does it
// (api-servers.ts:27 — blocking, no nonBlocking flag).
async function runServersGet(
  label: string,
  serversDir: string,
  projectsDir: string,
  assignmentsDir: string,
): Promise<number> {
  const start = performance.now();
  const result = await scanAllSessions(serversDir, projectsDir, { assignmentsDir });
  const ms = performance.now() - start;
  // eslint-disable-next-line no-console
  console.log(
    `[perf-bench:${label}] total=${ms.toFixed(1)}ms tmuxAvailable=${result.tmuxAvailable} sessions=${result.sessions.length}`,
  );
  return ms;
}

// Simulates the request fan-out a single hard page load fires: the overview
// route plus the palette-priming fetches in HotkeyProvider (projects,
// assignments, workspaces, servers). Run concurrently to mirror the browser.
async function runStartupSet(
  label: string,
  projectsDir: string,
  serversDir: string,
  assignmentsDir: string,
): Promise<number> {
  const start = performance.now();
  await Promise.all([
    getOverview(projectsDir, serversDir, assignmentsDir),
    listProjects(projectsDir),
    listAssignmentsBoard(projectsDir, assignmentsDir),
    listWorkspaces(projectsDir, assignmentsDir),
    scanAllSessions(serversDir, projectsDir, { assignmentsDir }),
  ]);
  const ms = performance.now() - start;
  // eslint-disable-next-line no-console
  console.log(`[perf-bench:${label}] total=${ms.toFixed(1)}ms`);
  return ms;
}

describe.skipIf(!ENABLED)('perf-overview synthetic 30x20', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'syntaur-perf-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('cold + warm + warm against 60 projects x 30 assignments', async () => {
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

describe.skipIf(!ENABLED || !process.env.SYNTAUR_PERF_BENCH_REAL)('perf-overview real workspace', () => {
  it('cold + warm against ~/.syntaur/projects', async () => {
    const real = resolve(homedir(), '.syntaur', 'projects');
    const cold = await runOnce('real-cold', real);
    const warm = await runOnce('real-warm', real);
    // eslint-disable-next-line no-console
    console.log(`[perf-bench:real-summary] cold=${cold.toFixed(1)}ms warm=${warm.toFixed(1)}ms`);
  }, 120_000);

  // The real startup path: full overview args (triggers the tmux scan),
  // a standalone /api/servers GET, and the concurrent startup request set.
  // This is the bench to re-run on the work Mac — copy the command from the
  // file header. `SYNTAUR_PERF_TRACE=1` adds per-phase JSON for getOverview.
  it('full startup path against ~/.syntaur', async () => {
    const projectsDir = resolve(homedir(), '.syntaur', 'projects');
    const serversDir = getServersDir();
    const assignmentsDir = getAssignmentsDir();

    const overviewCold = await runFullOverview('real-full-overview-cold', projectsDir, serversDir, assignmentsDir);
    const overviewWarm = await runFullOverview('real-full-overview-warm', projectsDir, serversDir, assignmentsDir);

    const serversCold = await runServersGet('real-servers-cold', serversDir, projectsDir, assignmentsDir);
    const serversWarm = await runServersGet('real-servers-warm', serversDir, projectsDir, assignmentsDir);

    const startupCold = await runStartupSet('real-startup-set-cold', projectsDir, serversDir, assignmentsDir);
    const startupWarm = await runStartupSet('real-startup-set-warm', projectsDir, serversDir, assignmentsDir);

    // eslint-disable-next-line no-console
    console.log(
      `[perf-bench:real-full-summary] overview cold=${overviewCold.toFixed(1)}ms warm=${overviewWarm.toFixed(1)}ms | ` +
        `servers cold=${serversCold.toFixed(1)}ms warm=${serversWarm.toFixed(1)}ms | ` +
        `startup-set cold=${startupCold.toFixed(1)}ms warm=${startupWarm.toFixed(1)}ms`,
    );
  }, 120_000);
});
