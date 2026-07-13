import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recomputeAndWrite, resolveRecomputeContext } from '../lifecycle/recompute.js';
import { parseAssignmentFrontmatter } from '../lifecycle/frontmatter.js';
import { invalidateWorkflowLibraryCache } from '../utils/workflow-library.js';

/**
 * WS-2 Task 2.8 — the DORMANCY golden guard (codex finding 13). The whole
 * pre-existing suite runs with `stages-migrated` unset and is the broad
 * characterization baseline; this is the focused tripwire proving the engine
 * WIRING is inert when dormant: even with a per-file workflow physically present
 * and resolvable, an UNSET marker keeps every recompute on the ladder and leaks
 * ZERO engine-only frontmatter artifacts (frozenChecks / gateOverrides /
 * firedVerdicts / hop `trigger`/`route` fields).
 */

const WORKFLOW = `id: feature
label: Feature
terminal_failure: failed
stages:
  - id: draft
    gate:
      - { check: hasRealObjective }
    next:
      - { to: done }
  - id: done
    terminal: true
`;

let home: string;
let priorHome: string | undefined;

const ASSIGNMENT = (status: string, withWorkflowField: boolean) => `---
id: t-id
slug: t
title: "T"
project: null
status: ${status}
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
${withWorkflowField ? 'workflow: feature\n' : ''}---
# T

## Objective

Real objective text.

## Acceptance Criteria

- [ ] First real criterion
`;

async function writeAssignment(content: string): Promise<string> {
  const dir = join(home, 'assignments', 't');
  await mkdir(dir, { recursive: true });
  const path = join(dir, 'assignment.md');
  await writeFile(path, content, 'utf-8');
  return path;
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'engine-dormancy-'));
  priorHome = process.env.SYNTAUR_HOME;
  process.env.SYNTAUR_HOME = home;
  invalidateWorkflowLibraryCache();
  // A per-file workflow is PRESENT and resolvable — but the marker is NEVER set.
  await mkdir(join(home, 'workflows'), { recursive: true });
  await writeFile(join(home, 'workflows', 'feature.md'), WORKFLOW, 'utf-8');
  invalidateWorkflowLibraryCache();
});

afterEach(async () => {
  if (priorHome === undefined) delete process.env.SYNTAUR_HOME;
  else process.env.SYNTAUR_HOME = priorHome;
  invalidateWorkflowLibraryCache();
  await rm(home, { recursive: true, force: true });
});

function noEngineArtifacts(fm: ReturnType<typeof parseAssignmentFrontmatter>): void {
  // Engine-only frontmatter slots must stay untouched on the ladder path.
  expect(fm.frozenChecks).toBeNull();
  expect(fm.gateOverrides ?? []).toHaveLength(0);
  expect(fm.firedVerdicts ?? []).toHaveLength(0);
  // Every history entry is ladder-shaped (dimension keys), never engine-shaped
  // (no per-hop trigger/route/gateSnapshot).
  for (const h of fm.statusHistory) {
    expect(h).not.toHaveProperty('trigger');
    expect(h).not.toHaveProperty('route');
    expect(h).not.toHaveProperty('gateSnapshot');
  }
}

describe('engine dormancy — marker unset keeps recompute on the ladder', () => {
  it('with the per-file workflow field set, an unset marker still derives via the ladder', async () => {
    const path = await writeAssignment(ASSIGNMENT('draft', true));
    const { context, workflowResolver } = await resolveRecomputeContext();
    const result = await recomputeAndWrite(path, {
      cause: 'derive',
      by: 'system',
      projectDir: null,
      context,
      workflowResolver,
    });
    expect(result.viaEngine).not.toBe(true);
    // The ladder derives a real-objective draft to ready_for_planning.
    expect(result.status).toBe('ready_for_planning');
    const fm = parseAssignmentFrontmatter(await readFile(path, 'utf-8'));
    expect(fm.status).toBe('ready_for_planning');
    expect(fm.statusHistory.at(-1)).toMatchObject({ dispositionTo: 'active' });
    noEngineArtifacts(fm);
  });

  it('without a workflow field either, the ladder result is identical (marker-independent)', async () => {
    const path = await writeAssignment(ASSIGNMENT('draft', false));
    const { context, workflowResolver } = await resolveRecomputeContext();
    const result = await recomputeAndWrite(path, {
      cause: 'derive',
      by: 'system',
      projectDir: null,
      context,
      workflowResolver,
    });
    expect(result.viaEngine).not.toBe(true);
    expect(result.status).toBe('ready_for_planning');
    noEngineArtifacts(parseAssignmentFrontmatter(await readFile(path, 'utf-8')));
  });
});
