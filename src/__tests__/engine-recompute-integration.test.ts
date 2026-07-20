import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  recomputeAndWrite,
  resolveRecomputeContext,
  markStagesMigrated,
} from '../lifecycle/recompute.js';
import { parseAssignmentFrontmatter } from '../lifecycle/frontmatter.js';
import {
  runEngineTransition,
  runEngineOverride,
  isEngineActiveForAssignment,
} from '../lifecycle/engine-transition.js';
import { assertStageFactOnOpen } from '../lifecycle/stage-fact-bridge.js';
import { reopenCommand } from '../commands/reopen.js';
import { invalidateWorkflowLibraryCache } from '../utils/workflow-library.js';

/**
 * WS-2 Tasks 2.6 / 2.7 / 2.8 — the MIGRATED integration proof: with the
 * `stages-migrated` marker set AND the assignment resolving to a per-file
 * StageWorkflow, `recomputeAndWrite` routes through the stage ENGINE (not the
 * ladder). Also the dormancy guard: with either precondition missing, the
 * ladder is taken (`viaEngine` falsy). The pure engine behaviors are unit-tested
 * in engine-step.test.ts; this file proves the WIRING end-to-end.
 */

const WORKFLOW = `id: feature
label: Feature
terminal_failure: failed
stages:
  - id: backlog
    next:
      - { to: building, on: work-start }
  - id: building
    gate:
      - { check: acAllChecked }
    next:
      - { to: reviewing }
  - id: reviewing
    gate:
      - { check: codeReviewed, by: human }
    next:
      - { to: done }
    on-dissent: building
  - id: done
    terminal: true
    reopen: building
  - id: failed
    terminal: true
`;

const ACS_CHECKED = `
## Objective

Real objective text.

## Acceptance Criteria

- [x] First real criterion
- [x] Second real criterion
`;

const ACS_UNCHECKED = `
## Objective

Real objective text.

## Acceptance Criteria

- [ ] First real criterion
- [ ] Second real criterion
`;

let home: string;
let priorHome: string | undefined;

function assignmentMd(opts: {
  status: string;
  workflow?: string | null; // null ⇒ omit the field (resolves to 'default')
  acsChecked?: boolean;
  extraFm?: string;
}): string {
  const wfLine = opts.workflow === null ? '' : `workflow: ${opts.workflow ?? 'feature'}\n`;
  return `---
id: t-id
slug: t
title: "T"
project: null
status: ${opts.status}
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
${wfLine}${opts.extraFm ?? ''}---
# T
${opts.acsChecked ? ACS_CHECKED : ACS_UNCHECKED}`;
}

async function writeAssignment(content: string): Promise<string> {
  const dir = join(home, 'assignments', 't');
  await mkdir(dir, { recursive: true });
  const path = join(dir, 'assignment.md');
  await writeFile(path, content, 'utf-8');
  return path;
}

async function recompute(path: string, engineMove: unknown, opts: { cause?: string; mutate?: (c: string) => string } = {}) {
  const { context, workflowResolver } = await resolveRecomputeContext();
  return recomputeAndWrite(path, {
    cause: opts.cause ?? 'derive',
    by: 'human',
    projectDir: null,
    context,
    workflowResolver,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    engineMove: engineMove as any,
    ...(opts.mutate ? { mutate: opts.mutate } : {}),
  });
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'engine-recompute-'));
  priorHome = process.env.SYNTAUR_HOME;
  process.env.SYNTAUR_HOME = home;
  invalidateWorkflowLibraryCache();
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

describe('recomputeAndWrite — migrated stage-engine wiring', () => {
  // ── Wiring + dormancy ──────────────────────────────────────────────────────
  it('marker set + per-file workflow → engine branch (viaEngine)', async () => {
    await markStagesMigrated();
    const path = await writeAssignment(assignmentMd({ status: 'backlog' }));
    const result = await recompute(path, { kind: 'work-start', actor: 'human' }, { cause: 'work-start' });
    expect(result.viaEngine).toBe(true);
    const fm = parseAssignmentFrontmatter(await readFile(path, 'utf-8'));
    // work-start route backlog→building; building gate (acAllChecked) fails → stops.
    expect(fm.status).toBe('building');
    expect(fm.statusHistory.at(-1)).toMatchObject({ trigger: 'work-start', from: 'backlog', to: 'building' });
  });

  it('DORMANT: marker UNSET + workflow present → ladder (not viaEngine)', async () => {
    // No markStagesMigrated() call.
    const path = await writeAssignment(assignmentMd({ status: 'backlog' }));
    const result = await recompute(path, { kind: 'work-start' }, { cause: 'work-start' });
    expect(result.viaEngine).not.toBe(true);
  });

  it('DORMANT: marker SET but assignment resolves to no per-file workflow → ladder', async () => {
    await markStagesMigrated();
    // `workflow: null` ⇒ resolves to 'default', which is NOT in the stage library.
    const path = await writeAssignment(assignmentMd({ status: 'draft', workflow: null }));
    const result = await recompute(path, { kind: 'gate' });
    expect(result.viaEngine).not.toBe(true);
  });

  // ── Drag / manual-override (Task 2.6) ──────────────────────────────────────
  it('forward drag past a failing gate stamps a GateOverride for the crossed gate', async () => {
    await markStagesMigrated();
    const path = await writeAssignment(assignmentMd({ status: 'building', acsChecked: false }));
    const result = await recompute(path, { kind: 'manual-override', target: 'reviewing', actor: 'human' }, { cause: 'pin' });
    expect(result.viaEngine).toBe(true);
    const fm = parseAssignmentFrontmatter(await readFile(path, 'utf-8'));
    expect(fm.status).toBe('reviewing'); // reviewing gate (codeReviewed) fails → stops here
    expect(fm.gateOverrides).toHaveLength(1);
    expect(fm.gateOverrides![0]).toMatchObject({ from: 'building', to: 'reviewing' });
  });

  it('backward drag writes NO override', async () => {
    await markStagesMigrated();
    const path = await writeAssignment(assignmentMd({ status: 'reviewing', acsChecked: false }));
    await recompute(path, { kind: 'manual-override', target: 'building', actor: 'human' }, { cause: 'pin' });
    const fm = parseAssignmentFrontmatter(await readFile(path, 'utf-8'));
    expect(fm.status).toBe('building');
    expect(fm.gateOverrides ?? []).toHaveLength(0);
  });

  // ── Terminal freeze + reopen ───────────────────────────────────────────────
  it('gate cascade to a terminal stage freezes checks + sets disposition terminal', async () => {
    await markStagesMigrated();
    const attestations = `attestations:\n  - fact: codeReviewed\n    actor: human\n    verdict: approved\n    at: "2026-06-09T10:00:00Z"\n`;
    const path = await writeAssignment(assignmentMd({ status: 'building', acsChecked: true, extraFm: attestations }));
    const result = await recompute(path, { kind: 'gate' });
    expect(result.viaEngine).toBe(true);
    expect(result.successTerminal).toBe(true);
    const fm = parseAssignmentFrontmatter(await readFile(path, 'utf-8'));
    expect(fm.status).toBe('done');
    expect(fm.disposition).toBe('terminal');
    expect(fm.frozenChecks).not.toBeNull();
  });

  it('reopen from a terminal stage re-places the ticket and clears the freeze', async () => {
    await markStagesMigrated();
    const frozen = `frozenChecks:\n  - key: "building:0"\n    label: acAllChecked\n    passed: true\n`;
    const path = await writeAssignment(assignmentMd({ status: 'done', acsChecked: true, extraFm: frozen }));
    const result = await recompute(path, { kind: 'reopen', actor: 'human' }, { cause: 'reopen' });
    expect(result.viaEngine).toBe(true);
    const fm = parseAssignmentFrontmatter(await readFile(path, 'utf-8'));
    // Reopen exits the terminal stage and clears the freeze; re-placement caps at
    // `done.reopen` (building), which is only work-start-reachable → lands backlog.
    expect(fm.status).not.toBe('done');
    expect(fm.disposition).not.toBe('terminal');
    expect(fm.frozenChecks).toBeNull();
  });

  // ── Dissent → note copy + firedVerdicts (Task 2.7) ─────────────────────────
  it('a dissent hop persists firedVerdicts, copies the note to comments, and does not double-fire', async () => {
    await markStagesMigrated();
    const attestations = `attestations:\n  - fact: codeReviewed\n    actor: human\n    verdict: changes-requested\n    at: "2026-06-09T10:00:00Z"\n    note: "Please fix the lock ordering"\n`;
    // ACs UNchecked so the on-dissent target `building` (gate acAllChecked) holds
    // instead of auto-advancing straight back to reviewing.
    const path = await writeAssignment(assignmentMd({ status: 'reviewing', acsChecked: false, extraFm: attestations }));

    const result = await recompute(path, { kind: 'gate' });
    expect(result.viaEngine).toBe(true);
    const fm = parseAssignmentFrontmatter(await readFile(path, 'utf-8'));
    expect(fm.status).toBe('building'); // routed on-dissent
    expect(fm.firedVerdicts?.length ?? 0).toBeGreaterThan(0);

    const commentsPath = join(home, 'assignments', 't', 'comments.md');
    const comments = await readFile(commentsPath, 'utf-8');
    expect(comments).toContain('Please fix the lock ordering');

    // Re-run: the dissent key already fired → no re-route, no duplicate comment.
    await recompute(path, { kind: 'gate' });
    const comments2 = await readFile(commentsPath, 'utf-8');
    expect(comments2.split('Please fix the lock ordering').length - 1).toBe(1);
  });

  // ── Pause-flag flip through the locked recompute (Task 2.6) ─────────────────
  it('park (a flag mutate) flips disposition without moving a stage', async () => {
    await markStagesMigrated();
    const path = await writeAssignment(assignmentMd({ status: 'building', acsChecked: false }));
    const { updateAssignmentFile } = await import('../lifecycle/frontmatter.js');
    const result = await recompute(path, { kind: 'gate' }, {
      cause: 'park',
      mutate: (c) => updateAssignmentFile(c, { parked: true }),
    });
    expect(result.viaEngine).toBe(true);
    const fm = parseAssignmentFrontmatter(await readFile(path, 'utf-8'));
    expect(fm.status).toBe('building'); // paused → no auto-advance
    expect(fm.disposition).toBe('parked');
    expect(fm.parked).toBe(true);
  });
});

describe('runEngineTransition / runEngineOverride — the CLI+dashboard adapters', () => {
  it('complete → forces to the success terminal stage', async () => {
    await markStagesMigrated();
    const path = await writeAssignment(assignmentMd({ status: 'building', acsChecked: true }));
    const result = await runEngineTransition({ assignmentPath: path, projectDir: null, command: 'complete', by: 'human' });
    expect(result?.success).toBe(true);
    expect(result?.toStatus).toBe('done');
  });

  it('returns null (→ ladder) when the marker is unset', async () => {
    const path = await writeAssignment(assignmentMd({ status: 'building' }));
    expect(await runEngineTransition({ assignmentPath: path, projectDir: null, command: 'complete', by: 'human' })).toBeNull();
  });

  it('returns null (→ ladder) when the stored status is NOT a stage in the workflow', async () => {
    await markStagesMigrated();
    // `in_progress` is a legacy ladder status, not one of this workflow's stages.
    const path = await writeAssignment(assignmentMd({ status: 'in_progress' }));
    expect(await runEngineTransition({ assignmentPath: path, projectDir: null, command: 'complete', by: 'human' })).toBeNull();
  });

  it('non-engine command (block) returns null (→ ladder)', async () => {
    await markStagesMigrated();
    const path = await writeAssignment(assignmentMd({ status: 'building' }));
    expect(await runEngineTransition({ assignmentPath: path, projectDir: null, command: 'block', by: 'human' })).toBeNull();
  });

  it('fail is refused (never moves to a success terminal) when there is no failure terminal', async () => {
    await markStagesMigrated();
    // A workflow with only a SUCCESS terminal — a `fail` must NOT fall back to it
    // (codex review major 1), else it would auto-complete linked todos.
    const noFail = `id: feature\nstages:\n  - id: building\n    gate:\n      - { check: acAllChecked }\n    next: [{ to: done }]\n  - id: done\n    terminal: true\n`;
    await writeFile(join(home, 'workflows', 'feature.md'), noFail, 'utf-8');
    invalidateWorkflowLibraryCache();
    const path = await writeAssignment(assignmentMd({ status: 'building' }));
    const result = await runEngineTransition({ assignmentPath: path, projectDir: null, command: 'fail', by: 'human' });
    expect(result?.success).toBe(false);
    expect(result?.message).toMatch(/failure terminal/i);
    // The ticket did NOT move to `done`.
    expect(parseAssignmentFrontmatter(await readFile(path, 'utf-8')).status).toBe('building');
  });

  it('isEngineActiveForAssignment: true only with marker AND a resolved workflow', async () => {
    const withWf = await writeAssignment(assignmentMd({ status: 'building' }));
    // marker unset → false even though the workflow resolves.
    expect(await isEngineActiveForAssignment(withWf, null)).toBe(false);
    await markStagesMigrated();
    expect(await isEngineActiveForAssignment(withWf, null)).toBe(true);
    // marker set but the assignment resolves to no per-file workflow → false.
    const noWf = await writeAssignment(assignmentMd({ status: 'draft', workflow: null }));
    expect(await isEngineActiveForAssignment(noWf, null)).toBe(false);
  });

  it('stage-fact bridge passes the work-start verb (WS-3 Task 0): implement does not fire a request-review route', async () => {
    await markStagesMigrated();
    // The compiled-default shape: in_progress's ONLY work-start route carries
    // `verb: request-review`; review routes back on `verb: rework`.
    const wf = `id: feature
stages:
  - id: in_progress
    gate: [{ condition: "acAllChecked:true" }]
    next:
      - { to: review, on: gate }
      - { to: review, on: work-start, verb: request-review }
  - id: review
    next:
      - { to: in_progress, on: work-start, verb: rework }
      - { to: done, on: manual }
  - id: done
    terminal: true
`;
    await writeFile(join(home, 'workflows', 'feature.md'), wf, 'utf-8');
    invalidateWorkflowLibraryCache();

    // `implement` at in_progress → verb `implement` matches no route → NO move
    // (pre-Task-0 this wrongly fired in_progress → review).
    const path = await writeAssignment(
      assignmentMd({ status: 'in_progress', acsChecked: false, extraFm: 'phase: in_progress\n' }),
    );
    await assertStageFactOnOpen({ assignmentPath: path, projectDir: null, stage: 'implement', by: 'human' });
    let fm = parseAssignmentFrontmatter(await readFile(path, 'utf-8'));
    expect(fm.status).toBe('in_progress');
    // The engine path was taken — the retired fact was NOT asserted.
    expect(fm.implementationStarted).toBe(false);

    // `review` open → verb `request-review` matches → in_progress → review.
    await assertStageFactOnOpen({ assignmentPath: path, projectDir: null, stage: 'review', by: 'human' });
    fm = parseAssignmentFrontmatter(await readFile(path, 'utf-8'));
    expect(fm.status).toBe('review');

    // `implement` after review (phase mirrors `review`) → verb `rework` → back
    // to in_progress.
    await assertStageFactOnOpen({ assignmentPath: path, projectDir: null, stage: 'implement', by: 'human' });
    fm = parseAssignmentFrontmatter(await readFile(path, 'utf-8'));
    expect(fm.status).toBe('in_progress');
  });

  it('stage-fact bridge: marker set + NO workflow still asserts the legacy fact (blocker 3)', async () => {
    await markStagesMigrated();
    // `workflow: null` ⇒ resolves to 'default' (not a per-file workflow) → the
    // engine recompute falls to the ladder; the bridge must still assert
    // implementationStarted (sessionless fallback, no engagement in this env).
    const path = await writeAssignment(assignmentMd({ status: 'in_progress', workflow: null }));
    await assertStageFactOnOpen({ assignmentPath: path, projectDir: null, stage: 'implement', by: 'human' });
    const fm = parseAssignmentFrontmatter(await readFile(path, 'utf-8'));
    expect(fm.implementationStarted).toBe(true);
  });

  it('CLI reopen does NOT re-cascade the engine reopen back to terminal (re-review)', async () => {
    await markStagesMigrated();
    // A 2-stage workflow whose reopen target (`building`) is gate-reachable and
    // whose gate PASSES — so a post-reopen default `gate` recompute WOULD push it
    // straight back to `done`. The reopenCommand guard must skip that recompute.
    const wf = `id: feature\nstages:\n  - id: building\n    gate:\n      - { check: acAllChecked }\n    next: [{ to: done }]\n  - id: done\n    terminal: true\n    reopen: building\nterminal_failure: failed\n`;
    await writeFile(join(home, 'workflows', 'feature.md'), wf, 'utf-8');
    invalidateWorkflowLibraryCache();

    // A standalone assignment (folder = its id) at status `done`, ACs all checked.
    const id = 'reopen-guard-0000';
    const dir = join(home, 'assignments', id);
    await mkdir(dir, { recursive: true });
    const content = `---
id: ${id}
slug: t
title: "T"
project: null
status: done
priority: medium
created: "2026-06-09T10:00:00Z"
updated: "2026-06-09T10:00:00Z"
assignee: null
externalIds: []
dependsOn: []
links: []
blockedReason: null
disposition: terminal
tags: []
workflow: feature
frozenChecks:
  - key: "building:0"
    label: acAllChecked
    passed: true
---
# T
${ACS_CHECKED}`;
    await writeFile(join(dir, 'assignment.md'), content, 'utf-8');

    await reopenCommand(id, {});

    const fm = parseAssignmentFrontmatter(await readFile(join(dir, 'assignment.md'), 'utf-8'));
    // Guard held: the engine reopen re-placed it at `building` and the legacy
    // re-derive was skipped, so it did NOT re-cascade to `done`.
    expect(fm.status).toBe('building');
  });

  it('override: pin to a valid stage moves there; unpin and terminal are refused', async () => {
    await markStagesMigrated();
    const path = await writeAssignment(assignmentMd({ status: 'building', acsChecked: false }));
    const pin = await runEngineOverride({ assignmentPath: path, projectDir: null, status: 'reviewing', by: 'human' });
    expect(pin).toMatchObject({ ok: true, status: 'reviewing' });

    const unpin = await runEngineOverride({ assignmentPath: path, projectDir: null, status: null, by: 'human' });
    expect(unpin).toMatchObject({ ok: false, code: 400 });

    const terminal = await runEngineOverride({ assignmentPath: path, projectDir: null, status: 'done', by: 'human' });
    expect(terminal).toMatchObject({ ok: false, code: 400 });
  });
});
