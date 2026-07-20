/**
 * WS-3 (`syntaur migrate-workflows`) — the migration + compat suite.
 *
 * Every fs-touching test runs against an mkdtemp root via `SYNTAUR_HOME`
 * (mirroring engine-recompute-integration.test.ts) — NEVER the real
 * `~/.syntaur`. The compiler tests (T1/T2) are pure.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, unlink, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  compileLadderWorkflow,
  classifyStatuses,
  COMPILE_SEMANTIC_CAVEAT,
} from '../lifecycle/ladder-compile.js';
import {
  migrateWorkflowsCommand,
  buildManualOnlyWorkflow,
  computeSeedDecision,
} from '../commands/migrate-workflows.js';
import { advance, evaluateRoutes, placeTicket, type EngineInput } from '../lifecycle/stage-engine.js';
import { findWorkflowStructureProblems } from '../utils/doctor/checks/workflows.js';
import { parseWorkflowFile, serializeWorkflowFile } from '../utils/workflow-file.js';
import { DEFAULT_DERIVE_CONFIG } from '../utils/derive-config.js';
import { readConfig, type StatusConfig } from '../utils/config.js';
import { getWorkflowBundle } from '../utils/workflow-resolve.js';
import { loadWorkflowLibrary, invalidateWorkflowLibraryCache } from '../utils/workflow-library.js';
import { buildDeriveContext } from '../lifecycle/derive-context.js';
import {
  isStagesMigrated,
  recomputeAndWrite,
  resolveRecomputeContext,
  contentHash,
} from '../lifecycle/recompute.js';
import { parseAssignmentFrontmatter } from '../lifecycle/frontmatter.js';
import type { StageWorkflow } from '../utils/stage-model.js';
import type { AssignmentFacts } from '../lifecycle/derive.js';

// ── Fixtures: the LIVE default-workflow bundle (verified 2026-07-13) ─────────
// Mirrors the real config.md `workflows.default`: 11 definitions (incl. the
// orphans `planning`/`code_review` and the pause states `blocked`/`parked`),
// no `derive:`/`transitions:` block → the built-in DEFAULT_DERIVE_CONFIG.

const LIVE_DEFAULT_BUNDLE: StatusConfig = {
  statuses: [
    { id: 'draft', label: 'Draft' },
    { id: 'ready_for_planning', label: 'Ready for Planning' },
    { id: 'ready_to_implement', label: 'Ready to Implement' },
    { id: 'planning', label: 'Planning' },
    { id: 'in_progress', label: 'In Progress' },
    { id: 'code_review', label: 'Code Review' },
    { id: 'review', label: 'Review' },
    { id: 'blocked', label: 'Blocked' },
    { id: 'completed', label: 'Completed', terminal: true },
    { id: 'failed', label: 'Failed', terminal: true },
    { id: 'parked', label: 'Parked' },
  ],
  order: [
    'draft',
    'ready_for_planning',
    'planning',
    'ready_to_implement',
    'in_progress',
    'code_review',
    'review',
    'blocked',
    'completed',
    'failed',
    'parked',
  ],
  transitions: [],
};

/** The concrete compiled `default` workflow the plan mandates (T1). */
const EXPECTED_DEFAULT: StageWorkflow = {
  id: 'default',
  stages: [
    {
      id: 'draft',
      gate: [{ check: '', condition: 'hasRealObjective:true AND acRealTotal > 0' }],
      next: [{ to: 'ready_for_planning', on: 'gate' }],
    },
    {
      id: 'ready_for_planning',
      gate: [{ check: '', condition: 'planApproved:true' }],
      next: [{ to: 'ready_to_implement', on: 'gate' }],
    },
    {
      // NO gate — the residual is only the retired implementationStarted fact.
      id: 'ready_to_implement',
      next: [{ to: 'in_progress', on: 'work-start', verb: 'implement' }],
    },
    {
      id: 'in_progress',
      gate: [{ check: '', condition: 'acAllChecked:true AND NOT reworkRequested:true' }],
      next: [
        { to: 'review', on: 'gate' },
        { to: 'review', on: 'work-start', verb: 'request-review' },
        { to: 'completed', on: 'manual' },
      ],
    },
    {
      id: 'review',
      next: [
        { to: 'in_progress', on: 'work-start', verb: 'rework' },
        { to: 'completed', on: 'manual' },
        { to: 'failed', on: 'manual' },
      ],
    },
    { id: 'completed', terminal: true, reopen: 'review' },
    { id: 'failed', terminal: true, reopen: 'review' },
  ],
  flags: {
    blocked: { when: 'blocked:true' },
    parked: { when: 'parked:true' },
    hold: {},
  },
  terminalFailure: 'failed',
};

function facts(overrides: Partial<AssignmentFacts> = {}): AssignmentFacts {
  return {
    hasRealObjective: false,
    acRealTotal: 0,
    acRealChecked: 0,
    acAllChecked: false,
    planExists: false,
    planApproved: false,
    workspaceSet: false,
    implementationStarted: false,
    depsSatisfied: true,
    unresolvedQuestions: 0,
    blocked: false,
    parked: false,
    reviewRequested: false,
    reworkRequested: false,
    pinned: false,
    ...overrides,
  } as AssignmentFacts;
}

function engineInput(overrides: Partial<EngineInput> = {}): EngineInput {
  return { facts: facts(), evidence: {}, firedDissents: new Set(), ...overrides };
}

// ── T1: the ladder → StageWorkflow compiler ──────────────────────────────────

describe('compileLadderWorkflow — the compiled default (T1)', () => {
  const { workflow, report } = compileLadderWorkflow('default', LIVE_DEFAULT_BUNDLE);

  it('compiles the live default bundle to EXACTLY the plan-mandated workflow', () => {
    expect(workflow).toEqual(EXPECTED_DEFAULT);
  });

  it('ready_to_implement has NO gate route — no auto-advance on a gate recompute (round-2 B3)', () => {
    const rti = workflow.stages.find((s) => s.id === 'ready_to_implement')!;
    expect(rti.gate).toBeUndefined();
    expect(rti.next?.every((r) => r.on !== 'gate')).toBe(true);
    // A ticket sitting there with planApproved:true does NOT move on a cascade…
    const result = advance(rti, workflow, engineInput({ facts: facts({ planApproved: true }) }));
    expect(result.final).toBe('ready_to_implement');
    expect(result.path).toEqual([]);
    // …and moves ONLY on the implement work-start verb.
    expect(evaluateRoutes(rti, workflow, engineInput(), 'work-start', 'implement')?.route.to).toBe(
      'in_progress',
    );
    expect(evaluateRoutes(rti, workflow, engineInput(), 'work-start', 'request-review')).toBeNull();
  });

  it('passes the doctor structural checks (terminals reachable, no unknown targets)', () => {
    expect(findWorkflowStructureProblems(workflow)).toEqual([]);
  });

  it('round-trips through parseWorkflowFile with zero issues; terminal_failure is the on-disk key', () => {
    const serialized = serializeWorkflowFile(workflow);
    expect(serialized).toContain('terminal_failure: failed');
    const { workflow: parsed, issues } = parseWorkflowFile(serialized);
    expect(issues).toEqual([]);
    expect(parsed.terminalFailure).toBe('failed');
    expect(parsed).toEqual(workflow);
  });

  it('placement stops honestly at ready_to_implement (waiting stage exits only by work-start)', () => {
    const placed = placeTicket(
      workflow,
      engineInput({
        facts: facts({ hasRealObjective: true, acRealTotal: 3, planApproved: true }),
      }),
    );
    expect(placed).toBe('ready_to_implement');
  });

  it('emits the forced-decision report: work-start verbs, terminals, flags, caveat', () => {
    expect(report.workflowId).toBe('default');
    expect(report.terminals).toEqual(['completed', 'failed']);
    expect(report.flags).toEqual({ blocked: 'blocked:true', parked: 'parked:true', hold: null });
    expect(report.caveat).toBe(COMPILE_SEMANTIC_CAVEAT);
    // The three retired-fact routes each surface as a forced decision with a verb.
    const verbs = report.decisions.filter((d) => d.outcome === 'work-start' && d.verb);
    expect(verbs.map((d) => d.verb)).toContain('implement');
    expect(verbs.map((d) => d.verb)).toContain('request-review');
    expect(verbs.map((d) => d.verb)).toContain('rework');
    // The implied-conjunct removal is documented (planApproved at ready_to_implement).
    expect(
      report.decisions.some((d) => d.outcome === 'implied' && d.conjunct === 'planApproved:true'),
    ).toBe(true);
  });
});

// ── T2: orphan + status classification ───────────────────────────────────────

describe('classifyStatuses / orphans (T2, decision D2)', () => {
  const { report } = compileLadderWorkflow('default', LIVE_DEFAULT_BUNDLE);

  it('surfaces exactly planning/code_review as orphan forced-decisions (delete-if-unused)', () => {
    expect(report.orphans.map((o) => o.id)).toEqual(['planning', 'code_review']);
    for (const o of report.orphans) expect(o.decision).toBe('delete-if-unused');
  });

  it('classifies blocked/parked as flags (not orphans), completed/failed as terminals, review as a rung', () => {
    const { rungs, terminals, flagIds, orphans } = classifyStatuses(
      LIVE_DEFAULT_BUNDLE,
      DEFAULT_DERIVE_CONFIG,
    );
    expect(rungs.has('review')).toBe(true); // a real rung, NOT an orphan (D2)
    expect(terminals).toEqual(['completed', 'failed']);
    expect(flagIds.has('blocked')).toBe(true);
    expect(flagIds.has('parked')).toBe(true);
    expect(orphans).toEqual(['planning', 'code_review']);
  });

  it('no compiled route targets an undefined stage', () => {
    const { workflow } = compileLadderWorkflow('default', LIVE_DEFAULT_BUNDLE);
    const ids = new Set(workflow.stages.map((s) => s.id));
    for (const s of workflow.stages) {
      for (const r of s.next ?? []) expect(ids.has(r.to)).toBe(true);
      if (s.reopen) expect(ids.has(s.reopen)).toBe(true);
    }
  });
});

// ── The command: fixture home (mirrors the LIVE config shape) ────────────────

/** A config.md mirroring the real one: `workflows:` with the ladder `default`
 * (orphans + pause states defined) and the transitions-block `test`, an
 * ABSOLUTE `defaultProjectDir` pointing at a DIFFERENT root (the trap the
 * migration must ignore), and `defaultWorkflow: default`. */
function liveShapedConfig(trapProjectsDir: string): string {
  return `---
version: "1.0"
defaultProjectDir: ${trapProjectsDir}
workflows:
  default:
    label: Default
    definitions:
      - id: draft
        label: Draft
        color: "#64748b"
      - id: ready_for_planning
        label: Ready for Planning
        color: "#7dd3fc"
      - id: ready_to_implement
        label: Ready to Implement
        color: "#34d399"
      - id: planning
        label: Planning
        color: "#60a5fa"
      - id: in_progress
        label: In Progress
        color: "#fbbf24"
      - id: code_review
        label: Code Review
        color: "#ec4899"
      - id: review
        label: Review
        color: "#f472b6"
      - id: blocked
        label: Blocked
        color: "#ef4444"
      - id: completed
        label: Completed
        color: "#22c55e"
        terminal: true
      - id: failed
        label: Failed
        color: "#dc2626"
        terminal: true
      - id: parked
        label: Parked
        color: slate
    order:
      - draft
      - ready_for_planning
      - planning
      - ready_to_implement
      - in_progress
      - code_review
      - review
      - blocked
      - completed
      - failed
      - parked
  test:
    label: test
    definitions:
      - id: pending
        label: Pending
        color: slate
      - id: in_progress
        label: In Progress
        color: teal
      - id: completed
        label: Completed
        color: emerald
        terminal: true
      - id: failed
        label: Failed
        color: rose
        terminal: true
    order:
      - pending
      - in_progress
      - completed
      - failed
    transitions:
      - from: pending
        command: start
        to: in_progress
      - from: in_progress
        command: complete
        to: completed
      - from: in_progress
        command: fail
        to: failed
defaultWorkflow: default
---

# Syntaur Configuration
`;
}

interface TicketSpec {
  slug: string;
  status: string;
  phase?: string | null;
  disposition?: string;
  blockedReason?: string;
  history?: Array<{ from: string | null; to: string }>;
  body?: string;
}

function ticketMd(spec: TicketSpec): string {
  const history =
    spec.history && spec.history.length > 0
      ? `statusHistory:\n${spec.history
          .map(
            (h) =>
              `  - at: "2026-07-01T00:00:00Z"\n    from: ${h.from ?? 'null'}\n    to: ${h.to}\n    command: test\n    by: human`,
          )
          .join('\n')}\n`
      : 'statusHistory: []\n';
  const phase = spec.phase === undefined ? '' : `phase: ${spec.phase ?? 'null'}\n`;
  const disposition = spec.disposition ? `disposition: ${spec.disposition}\n` : '';
  const blocked = spec.blockedReason ? `blockedReason: "${spec.blockedReason}"\n` : '';
  return `---
id: id-${spec.slug}
slug: ${spec.slug}
title: "T ${spec.slug}"
project: proj
status: ${spec.status}
priority: medium
created: "2026-06-01T00:00:00Z"
updated: "2026-06-01T00:00:00Z"
assignee: null
${history}${phase}${disposition}${blocked}---
# T
${spec.body ?? '\n## Objective\n\nTBD\n\n## Acceptance Criteria\n\n- [ ] one\n'}`;
}

/** Recursive content snapshot of a directory tree (relpath → sha256). */
async function snapshotTree(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  async function walk(cur: string, rel: string): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(cur);
    } catch {
      return;
    }
    for (const e of entries) {
      const abs = join(cur, e);
      const r = rel ? `${rel}/${e}` : e;
      const s = await stat(abs);
      if (s.isDirectory()) await walk(abs, r);
      else out[r] = contentHash(await readFile(abs, 'utf-8'));
    }
  }
  await walk(dir, '');
  return out;
}

describe('syntaur migrate-workflows — the command (T3–T6)', () => {
  let home: string;
  let trap: string; // simulates the REAL root the copied config points back at
  let priorHome: string | undefined;

  async function seedHome(tickets: TicketSpec[], standalone: TicketSpec[] = []): Promise<void> {
    await mkdir(join(trap, 'projects'), { recursive: true });
    await writeFile(join(home, 'config.md'), liveShapedConfig(join(trap, 'projects')), 'utf-8');
    for (const t of tickets) {
      const dir = join(home, 'projects', 'proj', 'assignments', t.slug);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'assignment.md'), ticketMd(t), 'utf-8');
    }
    for (const t of standalone) {
      const dir = join(home, 'assignments', t.slug);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'assignment.md'), ticketMd({ ...t }), 'utf-8');
    }
  }

  const FIXTURES: TicketSpec[] = [
    // The corruption trap: 89 live completed tickets carry phase: review.
    { slug: 'done-review', status: 'completed', phase: 'review', disposition: 'terminal' },
    { slug: 'failed-one', status: 'failed', phase: 'review', disposition: 'terminal' },
    // Active, already in place (status == phase == stage).
    { slug: 'active-phase', status: 'ready_to_implement', phase: 'ready_to_implement' },
    // The live blocked ticket shape: pause STATUS + real phase + reason.
    {
      slug: 'blocked-one',
      status: 'blocked',
      phase: 'ready_for_planning',
      disposition: 'blocked',
      blockedReason: 'waiting on upstream',
      history: [
        { from: null, to: 'ready_for_planning' },
        { from: 'ready_for_planning', to: 'blocked' },
      ],
    },
    // No phase → last-non-flag statusHistory.to.
    {
      slug: 'history-only',
      status: 'in_progress',
      history: [
        { from: null, to: 'in_progress' },
        { from: 'in_progress', to: 'blocked' },
      ],
    },
    // Orphan phase → falls through to the history candidate.
    {
      slug: 'phase-orphan',
      status: 'code_review',
      phase: 'planning',
      history: [{ from: null, to: 'review' }],
    },
  ];
  // Fresh standalone: no phase, no history, stub body (no real objective/ACs)
  // → placeTicket() stops at draft (its exit gate fails).
  const STANDALONE: TicketSpec[] = [
    { slug: 'fresh-standalone-0001', status: 'draft', body: '\n## Objective\n\nTBD\n' },
  ];

  const asg = (slug: string): string =>
    join(home, 'projects', 'proj', 'assignments', slug, 'assignment.md');
  const fmOf = async (path: string) => parseAssignmentFrontmatter(await readFile(path, 'utf-8'));

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'migrate-wf-home-'));
    trap = await mkdtemp(join(tmpdir(), 'migrate-wf-trap-'));
    priorHome = process.env.SYNTAUR_HOME;
    process.env.SYNTAUR_HOME = home;
    invalidateWorkflowLibraryCache();
  });

  afterEach(async () => {
    if (priorHome === undefined) delete process.env.SYNTAUR_HOME;
    else process.env.SYNTAUR_HOME = priorHome;
    invalidateWorkflowLibraryCache();
    await rm(home, { recursive: true, force: true });
    await rm(trap, { recursive: true, force: true });
  });

  // ── T3: --root / SYNTAUR_HOME isolation ───────────────────────────────────
  it('dry-run writes NOTHING — not under the root, and never under the copied defaultProjectDir trap', async () => {
    // Put a trap assignment where the copied config's absolute defaultProjectDir
    // points (the REAL root in the live scenario) — it must never be touched.
    const trapAsg = join(trap, 'projects', 'trapproj', 'assignments', 'trapped');
    await mkdir(trapAsg, { recursive: true });
    await writeFile(join(trapAsg, 'assignment.md'), ticketMd({ slug: 'trapped', status: 'blocked' }), 'utf-8');
    await seedHome(FIXTURES, STANDALONE);

    const homeBefore = await snapshotTree(home);
    const trapBefore = await snapshotTree(trap);
    await migrateWorkflowsCommand({ root: home, dryRun: true });
    expect(await snapshotTree(home)).toEqual(homeBefore);
    expect(await snapshotTree(trap)).toEqual(trapBefore);
    expect(await isStagesMigrated()).toBe(false); // dry-run never sets the marker
  });

  it('apply migrates ONLY under --root; the trap root is untouched', async () => {
    const trapAsg = join(trap, 'projects', 'trapproj', 'assignments', 'trapped');
    await mkdir(trapAsg, { recursive: true });
    await writeFile(join(trapAsg, 'assignment.md'), ticketMd({ slug: 'trapped', status: 'blocked' }), 'utf-8');
    await seedHome(FIXTURES, STANDALONE);

    const trapBefore = await snapshotTree(trap);
    await migrateWorkflowsCommand({ root: home });
    expect(await snapshotTree(trap)).toEqual(trapBefore); // zero writes outside <root>
    expect(await isStagesMigrated()).toBe(true);
  });

  // ── T4: relocation + §4.6 exclusivity ─────────────────────────────────────
  it('clean apply: per-file workflows written, whole block stripped, scalar set, loader never throws', async () => {
    await seedHome(FIXTURES, STANDALONE);
    await migrateWorkflowsCommand({ root: home });

    const defaultMd = await readFile(join(home, 'workflows', 'default.md'), 'utf-8');
    const testMd = await readFile(join(home, 'workflows', 'test.md'), 'utf-8');
    expect(defaultMd).toContain('terminal_failure: failed');
    expect(testMd).toContain('transitions:'); // relocated verbatim (raw passthrough)

    const configRaw = await readFile(join(home, 'config.md'), 'utf-8');
    expect(configRaw).not.toMatch(/^workflows:\s*$/m);
    expect(configRaw).not.toMatch(/^statuses:\s*$/m);
    expect(configRaw).toMatch(/^defaultWorkflow: default$/m);

    invalidateWorkflowLibraryCache();
    const config = await readConfig();
    const library = loadWorkflowLibrary(config); // §4.6: must not throw
    expect(Object.keys(library).sort()).toEqual(['default', 'test']);
    // The relocated default IS the compiled default (parsed round-trip).
    expect(library.default.stages.map((s) => s.id)).toEqual([
      'draft',
      'ready_for_planning',
      'ready_to_implement',
      'in_progress',
      'review',
      'completed',
      'failed',
    ]);
    expect(library.default.terminalFailure).toBe('failed');
    // The manual-only test workflow: stages, terminals — and NO routes.
    expect(library.test.stages.map((s) => s.id)).toEqual(['pending', 'in_progress', 'completed', 'failed']);
    expect(library.test.stages.every((s) => (s.next ?? []).length === 0)).toBe(true);
    expect(library.test.stages.find((s) => s.id === 'completed')?.terminal).toBe(true);
  });

  it('second apply is a no-op (idempotent re-run)', async () => {
    await seedHome(FIXTURES, STANDALONE);
    await migrateWorkflowsCommand({ root: home });
    const after = await snapshotTree(home);
    await migrateWorkflowsCommand({ root: home });
    expect(await snapshotTree(home)).toEqual(after);
  });

  it('crash after only default.md: re-run writes test.md, strips the block, sets the scalar', async () => {
    await seedHome(FIXTURES, STANDALONE);
    // Simulate the partial crash: the compiled default.md exists; test.md does
    // not; the config block is still present.
    const config = await readConfig();
    const { workflow } = compileLadderWorkflow('default', getWorkflowBundle(config, 'default'));
    await mkdir(join(home, 'workflows'), { recursive: true });
    await writeFile(join(home, 'workflows', 'default.md'), serializeWorkflowFile(workflow), 'utf-8');

    await migrateWorkflowsCommand({ root: home });
    expect(await readFile(join(home, 'workflows', 'test.md'), 'utf-8')).toContain('transitions:');
    const configRaw = await readFile(join(home, 'config.md'), 'utf-8');
    expect(configRaw).not.toMatch(/^workflows:\s*$/m);
    expect(configRaw).toMatch(/^defaultWorkflow: default$/m);
    expect(await isStagesMigrated()).toBe(true);
  });

  it('crash after block-strip before scalar: re-run converges (byte-identical default.md) and sets the scalar', async () => {
    await seedHome(FIXTURES, STANDALONE);
    await migrateWorkflowsCommand({ root: home });
    const defaultBefore = await readFile(join(home, 'workflows', 'default.md'), 'utf-8');

    // Simulate: scalar missing + marker missing (crashed between strip and scalar).
    const configRaw = await readFile(join(home, 'config.md'), 'utf-8');
    await writeFile(join(home, 'config.md'), configRaw.replace(/^defaultWorkflow:[^\n]*\n/m, ''), 'utf-8');
    await unlink(join(home, 'stages-migrated'));
    invalidateWorkflowLibraryCache();

    await migrateWorkflowsCommand({ root: home });
    // Convergence: the re-run (now compiling from the synthesized built-in
    // bundle — the block is gone) produces a BYTE-IDENTICAL default.md.
    expect(await readFile(join(home, 'workflows', 'default.md'), 'utf-8')).toBe(defaultBefore);
    expect(await readFile(join(home, 'config.md'), 'utf-8')).toMatch(/^defaultWorkflow: default$/m);
    expect(await isStagesMigrated()).toBe(true);
  });

  it('a DIFFERING existing per-file aborts without clobbering; marker stays false', async () => {
    await seedHome(FIXTURES, STANDALONE);
    await mkdir(join(home, 'workflows'), { recursive: true });
    const handEdited = 'id: default\nstages:\n  - id: my_custom_stage\n    terminal: true\n';
    await writeFile(join(home, 'workflows', 'default.md'), handEdited, 'utf-8');

    await expect(migrateWorkflowsCommand({ root: home })).rejects.toThrow(/refusing to clobber/i);
    // Not clobbered; block still present; marker never set; no seeding ran.
    expect(await readFile(join(home, 'workflows', 'default.md'), 'utf-8')).toBe(handEdited);
    expect(await readFile(join(home, 'config.md'), 'utf-8')).toMatch(/^workflows:\s*$/m);
    expect(await isStagesMigrated()).toBe(false);
    expect((await fmOf(asg('blocked-one'))).status).toBe('blocked');
  });

  // ── T5: seeding (terminal-safe, validated) + pause remap ──────────────────
  it('terminal preservation: completed + phase:review keeps status completed VERBATIM; failed untouched', async () => {
    await seedHome(FIXTURES, STANDALONE);
    const doneBefore = await readFile(asg('done-review'), 'utf-8');
    const failedBefore = await readFile(asg('failed-one'), 'utf-8');
    await migrateWorkflowsCommand({ root: home });
    // Preserved verbatim — the whole file is untouched, not just `status`.
    expect(await readFile(asg('done-review'), 'utf-8')).toBe(doneBefore);
    expect(await readFile(asg('failed-one'), 'utf-8')).toBe(failedBefore);
  });

  it('seeding rule: phase ?? last-non-flag history.to ?? placeTicket(), validated per candidate', async () => {
    await seedHome(FIXTURES, STANDALONE);
    await migrateWorkflowsCommand({ root: home });

    // Already in place → untouched.
    expect((await fmOf(asg('active-phase'))).status).toBe('ready_to_implement');
    // No phase → last-non-flag history entry (`blocked` skipped → in_progress).
    const history = await fmOf(asg('history-only'));
    expect(history.status).toBe('in_progress');
    expect(history.phase).toBe('in_progress');
    // Orphan phase (planning) → falls to the history candidate (review).
    const orphan = await fmOf(asg('phase-orphan'));
    expect(orphan.status).toBe('review');
    expect(orphan.phase).toBe('review');
    // Fresh standalone (no phase, no history) → placeTicket() → draft.
    const fresh = parseAssignmentFrontmatter(
      await readFile(join(home, 'assignments', 'fresh-standalone-0001', 'assignment.md'), 'utf-8'),
    );
    expect(fresh.status).toBe('draft');
  });

  it('blocked remap: status → real stage, blockedReason preserved, history relabeled, no directory deleted', async () => {
    await seedHome(FIXTURES, STANDALONE);
    await migrateWorkflowsCommand({ root: home });

    const fm = await fmOf(asg('blocked-one'));
    expect(fm.status).toBe('ready_for_planning');
    expect(fm.phase).toBe('ready_for_planning');
    expect(fm.blockedReason).toBe('waiting on upstream');
    // History relabeled — `blocked` is no longer a status id anywhere in it.
    expect(fm.statusHistory.some((h) => h.to === 'blocked' || h.from === 'blocked')).toBe(false);
    // The assignment directory still exists (never deleted).
    expect((await readdir(join(home, 'projects', 'proj', 'assignments'))).sort()).toContain('blocked-one');
  });

  it('CONTROL (round-2 M4): pre-marker recomputeAndWrite WOULD re-derive the seeded stage back to blocked', async () => {
    await seedHome([FIXTURES[3]]); // blocked-one only
    // Manually seed the stage the way the migration would — but through the
    // LADDER writer instead of the migration-only writer.
    const { context, workflowResolver } = await resolveRecomputeContext();
    const { updateAssignmentFile } = await import('../lifecycle/frontmatter.js');
    const result = await recomputeAndWrite(asg('blocked-one'), {
      cause: 'migrate',
      by: 'system',
      projectDir: join(home, 'projects', 'proj'),
      context,
      workflowResolver,
      mutate: (c) => updateAssignmentFile(c, { status: 'ready_for_planning' }),
    });
    // The pre-marker ladder branch derives facts.blocked (blockedReason is
    // preserved) → the headline projection rewrites status straight back.
    expect(result.status).toBe('blocked');
    expect((await fmOf(asg('blocked-one'))).status).toBe('blocked');
  });

  it('AFTER the marker: the blocked flag re-derives true (paused — no auto-advance; disposition blocked)', async () => {
    await seedHome(FIXTURES, STANDALONE);
    await migrateWorkflowsCommand({ root: home });

    // Post-marker engine recompute on the remapped ticket: blockedReason →
    // facts.blocked → the ticket is paused at its real stage.
    const { context, workflowResolver } = await resolveRecomputeContext();
    const result = await recomputeAndWrite(asg('blocked-one'), {
      cause: 'derive',
      by: 'system',
      projectDir: join(home, 'projects', 'proj'),
      context,
      workflowResolver,
      engineMove: { kind: 'gate' },
    });
    expect(result.viaEngine).toBe(true);
    const fm = await fmOf(asg('blocked-one'));
    expect(fm.status).toBe('ready_for_planning'); // no auto-advance while paused
    expect(fm.disposition).toBe('blocked'); // the flag re-reads true post-marker
  });

  // ── T6: the marker ────────────────────────────────────────────────────────
  it('marker: false pre-apply, false after an invalid-seed abort, true only after a clean apply', async () => {
    await seedHome(FIXTURES, STANDALONE);
    expect(await isStagesMigrated()).toBe(false);

    // The invalid-seed abort (unit level — unreachable via a well-formed
    // config): an empty workflow yields no valid final candidate.
    const ctx = buildDeriveContext(getWorkflowBundle(await readConfig(), 'default'));
    const decision = await computeSeedDecision(
      { path: asg('active-phase'), projectDir: join(home, 'projects', 'proj'), ref: 'proj/active-phase' },
      await readFile(asg('active-phase'), 'utf-8'),
      { id: 'empty', stages: [] },
      ctx,
    );
    expect('error' in decision && decision.error).toMatch(/no valid seed stage/);

    await migrateWorkflowsCommand({ root: home });
    expect(await isStagesMigrated()).toBe(true);
  });

  // ── Startup-hook isolation (round-3 major): an npx-style CLI invocation ───
  it('CLI invocation of migrate-workflows skips the startup nudges — zero writes to the ambient root', async () => {
    await seedHome(FIXTURES, STANDALONE);
    const fakeReal = await mkdtemp(join(tmpdir(), 'migrate-wf-fakereal-'));
    try {
      const before = await snapshotTree(fakeReal);
      const res = spawnSync(
        process.execPath,
        [resolve('dist/index.js'), 'migrate-workflows', '--root', home, '--dry-run'],
        {
          env: { ...process.env, SYNTAUR_HOME: fakeReal, npm_config_user_agent: 'npx/10.0.0' },
          encoding: 'utf-8',
          timeout: 60_000,
        },
      );
      expect(res.status).toBe(0);
      // The ambient (fake-real) root got NO writes: no npx-install.json, no
      // nudge state, no marker — the startup hooks were skipped entirely.
      expect(await snapshotTree(fakeReal)).toEqual(before);
      // And the dry-run wrote nothing under --root either.
      expect(res.stdout).toContain('[dry-run]');
    } finally {
      await rm(fakeReal, { recursive: true, force: true });
    }
  });
});

// ── buildManualOnlyWorkflow (T4, decision D1) ────────────────────────────────

describe('buildManualOnlyWorkflow (decision D1)', () => {
  it('relocates a transitions workflow verbatim: stages, terminals, transitions preserved on raw, no routes', () => {
    const wf = buildManualOnlyWorkflow('test', {
      label: 'test',
      statuses: [
        { id: 'pending', label: 'Pending', color: 'slate' },
        { id: 'in_progress', label: 'In Progress', color: 'teal', description: 'Working' },
        { id: 'completed', label: 'Completed', color: 'emerald', terminal: true },
        { id: 'failed', label: 'Failed', color: 'rose', terminal: true },
      ],
      order: ['pending', 'in_progress', 'completed', 'failed'],
      transitions: [
        { from: 'pending', command: 'start', to: 'in_progress' },
        { from: 'in_progress', command: 'fail', to: 'failed' },
      ],
    });
    expect(wf.stages.map((s) => s.id)).toEqual(['pending', 'in_progress', 'completed', 'failed']);
    expect(wf.stages.every((s) => s.next === undefined && s.gate === undefined)).toBe(true);
    expect(wf.stages.find((s) => s.id === 'in_progress')?.raw).toEqual({ description: 'Working' });
    expect(wf.terminalFailure).toBe('failed'); // from the fail transition target
    expect(wf.raw).toEqual({
      transitions: [
        { from: 'pending', command: 'start', to: 'in_progress' },
        { from: 'in_progress', command: 'fail', to: 'failed' },
      ],
    });
    // Round-trips through the per-file parser with zero issues; the legacy
    // transitions survive as an unknown top-level key (no silent deletion).
    const { workflow: parsed, issues } = parseWorkflowFile(serializeWorkflowFile(wf));
    expect(issues).toEqual([]);
    expect(parsed.raw?.transitions).toBeDefined();
  });
});
