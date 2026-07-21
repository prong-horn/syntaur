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
import { ASSIGNMENT_FIELDS, compileQuery } from '../utils/query/index.js';
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
  workflow?: string;
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
  const workflow = spec.workflow ? `workflow: ${spec.workflow}\n` : '';
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
${history}${phase}${disposition}${blocked}${workflow}---
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

  it('post-strip re-run loads the relocated per-file set — a test-bound ticket is NOT reseeded into default stages (codex code-r1 blocker)', async () => {
    await seedHome(
      [...FIXTURES, { slug: 'test-bound', status: 'pending', phase: 'pending', workflow: 'test' }],
      STANDALONE,
    );
    await migrateWorkflowsCommand({ root: home });
    // Apply #1: `pending` is a valid stage of the relocated manual-only `test`
    // workflow → the ticket is untouched.
    expect((await fmOf(asg('test-bound'))).status).toBe('pending');
    const testMdBefore = await readFile(join(home, 'workflows', 'test.md'), 'utf-8');

    // Simulate a post-strip pre-marker crash: block gone, per-file set written,
    // marker missing. The re-run must load the expected set from DISK (incl.
    // `test`) — recompiling from the now-synthesized {default}-only library
    // would shrink availableIds and reseed this ticket into a default stage.
    await unlink(join(home, 'stages-migrated'));
    invalidateWorkflowLibraryCache();
    await migrateWorkflowsCommand({ root: home });

    expect((await fmOf(asg('test-bound'))).status).toBe('pending'); // NOT draft
    expect(await readFile(join(home, 'workflows', 'test.md'), 'utf-8')).toBe(testMdBefore);
    expect(await isStagesMigrated()).toBe(true);
  });

  it('post-strip re-run rejects a STRUCTURALLY invalid relocated file before seeding (codex code-r2)', async () => {
    await seedHome(FIXTURES, STANDALONE);
    await migrateWorkflowsCommand({ root: home });
    const seededSnapshot = await snapshotTree(join(home, 'projects'));

    // A relocated file that parses clean but fails the doctor's structural
    // rules: no terminal stage + a route to an unknown stage. And simulate the
    // post-strip pre-marker crash so the loader takes the from-disk path.
    await writeFile(
      join(home, 'workflows', 'broken.md'),
      'id: broken\nstages:\n  - id: a\n    next: [{ to: ghost }]\n',
      'utf-8',
    );
    await unlink(join(home, 'stages-migrated'));
    invalidateWorkflowLibraryCache();

    await expect(migrateWorkflowsCommand({ root: home })).rejects.toThrow(/is invalid/i);
    // Aborted before any seeding write; marker stays unset.
    expect(await snapshotTree(join(home, 'projects'))).toEqual(seededSnapshot);
    expect(await isStagesMigrated()).toBe(false);

    // Filename/id mismatch is equally structural: broken.md fixed but renamed id.
    await writeFile(
      join(home, 'workflows', 'broken.md'),
      'id: other\nstages:\n  - id: a\n    terminal: true\n',
      'utf-8',
    );
    invalidateWorkflowLibraryCache();
    await expect(migrateWorkflowsCommand({ root: home })).rejects.toThrow(/filename stem/i);

    // A flag id shadowing a stage id corrupts the seeding history-walk/remap
    // (codex code-r3): must also abort before seeding.
    await writeFile(
      join(home, 'workflows', 'broken.md'),
      'id: broken\nstages:\n  - id: draft\n  - id: review\n  - id: done\n    terminal: true\nflags:\n  review: {}\n',
      'utf-8',
    );
    invalidateWorkflowLibraryCache();
    await expect(migrateWorkflowsCommand({ root: home })).rejects.toThrow(/collides with a stage id/i);
  });

  it('marker write is idempotent: a completed migration re-run leaves stages-migrated byte-identical', async () => {
    await seedHome(FIXTURES, STANDALONE);
    await migrateWorkflowsCommand({ root: home });
    // Sentinel content: an idempotent marker write must not touch an existing
    // marker (a rewrite would replace this with a fresh timestamp).
    await writeFile(join(home, 'stages-migrated'), 'sentinel\n', 'utf-8');
    invalidateWorkflowLibraryCache();
    await migrateWorkflowsCommand({ root: home });
    expect(await readFile(join(home, 'stages-migrated'), 'utf-8')).toBe('sentinel\n');
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

  // ── T8: dashboard payload mirrors + workflow-metadata rewire ──────────────
  it('T8: workflow metadata reads the per-file library post-relocation (non-empty, incl. test)', async () => {
    await seedHome(FIXTURES, STANDALONE);
    const { effectiveWorkflowIds, clearStatusConfigCache } = await import('../dashboard/api.js');
    // Pre-migration: the legacy config block is the source.
    expect((await effectiveWorkflowIds(await readConfig())).sort()).toEqual(['default', 'test']);

    await migrateWorkflowsCommand({ root: home });
    clearStatusConfigCache();
    invalidateWorkflowLibraryCache();
    // Post-relocation the config block is GONE — the per-file library must be
    // the metadata source, or `test` would vanish and the workflow UI break.
    expect((await effectiveWorkflowIds(await readConfig())).sort()).toEqual(['default', 'test']);
  });

  it('T8: detail payload keeps the deprecated mirrors; nextAction == active stage guidance', async () => {
    await seedHome(FIXTURES, STANDALONE);
    await migrateWorkflowsCommand({ root: home });

    // Author a `guidance:` on the active ticket's stage (the compiled default
    // ships none — the mirror maps to whatever the stage declares).
    const wfPath = join(home, 'workflows', 'default.md');
    const { workflow } = parseWorkflowFile(await readFile(wfPath, 'utf-8'));
    workflow.stages.find((s) => s.id === 'ready_to_implement')!.guidance = 'Start implementing';
    await writeFile(wfPath, serializeWorkflowFile(workflow), 'utf-8');
    invalidateWorkflowLibraryCache();

    const { getAssignmentDetail, clearStatusConfigCache } = await import('../dashboard/api.js');
    clearStatusConfigCache();
    const detail = await getAssignmentDetail(join(home, 'projects'), 'proj', 'active-phase');
    expect(detail).not.toBeNull();
    // The four deprecated §4.5 mirrors are still in the payload…
    expect(detail!.phase).toBe('ready_to_implement');
    expect(detail).toHaveProperty('disposition'); // mirror carried (null — never stored on this ticket)
    expect(detail!.derived).not.toBeNull();
    // …and on the engine-active path they mirror the STORED stage + guidance.
    expect(detail!.derived!.derivedStatus).toBe('ready_to_implement');
    expect(detail!.derived!.nextAction).toBe('Start implementing');
  });

  // ── T9b: legacy config-workflow writers hard-refuse post-marker ───────────
  it('T9b: writeStatusConfig / writeWorkflowsConfig / writeWorkflowBundle / setDefaultWorkflow refuse post-marker; the loader never bricks', async () => {
    await seedHome(FIXTURES, STANDALONE);
    await migrateWorkflowsCommand({ root: home });

    const { writeStatusConfig, writeWorkflowsConfig } = await import('../utils/config.js');
    const { writeWorkflowBundle, setDefaultWorkflow, deleteWorkflowFromConfig } = await import(
      '../utils/workflow-write.js'
    );
    const { buildDefaultStatusConfig } = await import('../utils/status-defaults.js');
    const bundle = buildDefaultStatusConfig();

    await expect(writeStatusConfig(bundle)).rejects.toThrow(/migrated to per-file/);
    await expect(
      writeWorkflowsConfig({ default: { label: 'Default', ...bundle } }, 'default'),
    ).rejects.toThrow(/migrated to per-file/);
    await expect(writeWorkflowBundle('custom', bundle)).rejects.toThrow(/migrated to per-file/);
    await expect(setDefaultWorkflow('default')).rejects.toThrow(/migrated to per-file/);
    // Post-strip, `test` is absent from the LEGACY library → a delete attempt
    // is a no-op that must NOT regrow the block.
    await deleteWorkflowFromConfig('test');

    const configRaw = await readFile(join(home, 'config.md'), 'utf-8');
    expect(configRaw).not.toMatch(/^workflows:\s*$/m);
    expect(configRaw).not.toMatch(/^statuses:\s*$/m);
    invalidateWorkflowLibraryCache();
    expect(() => loadWorkflowLibrary({ workflows: null, statuses: null })).not.toThrow();
  });

  it('T9b: pre-marker the legacy writers work unchanged', async () => {
    await seedHome(FIXTURES, STANDALONE);
    const { writeWorkflowBundle } = await import('../utils/workflow-write.js');
    const { buildDefaultStatusConfig } = await import('../utils/status-defaults.js');
    await writeWorkflowBundle('extra', buildDefaultStatusConfig(), { label: 'Extra' });
    const config = await readConfig();
    expect(config.workflows && 'extra' in config.workflows).toBe(true);
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

// ── T7: the AQL compat window (aliases + parse-time deprecation, §4.5) ───────

describe('AQL compat window (T7)', () => {
  const registry = ASSIGNMENT_FIELDS;
  const now = Date.now();

  /** A post-compat-window item: NO phase/disposition mirrors — only the stage
   * (`status`) and the pause flags, as the engine world stores them. */
  const engineItem = {
    status: 'ready_for_planning',
    blocked: true,
    parked: false,
    statusAge: 5 * 24 * 60 * 60 * 1000,
    phaseAge: null,
    phase: null,
    disposition: null,
    pinned: true, // even a stale truthy value must read false (retired)
  };

  const evaluate = (expr: string, item: Record<string, unknown>): boolean => {
    const { query, errors } = compileQuery(expr, registry);
    expect(errors).toEqual([]);
    return query!.predicate(item, { now });
  };

  it('`phase:` aliases to the stage (status) when the deprecated mirror is absent', () => {
    expect(evaluate('phase:ready_for_planning', engineItem)).toBe(true);
    expect(evaluate('phase:draft', engineItem)).toBe(false);
    // The ACCESSOR prefers a present `phase` value — but post-marker the
    // MATERIALIZATION layers (ls.ts loadQueryItem, api.ts deriveStatusVirtuals)
    // set `phase := status`, so a query item never carries a stale mirror
    // (preserved terminals keep e.g. frontmatter `phase: review` forever —
    // codex code-r1). This item-level test only pins the accessor fallback.
    expect(evaluate('phase:review', { ...engineItem, phase: 'review' })).toBe(true);
  });

  it('`disposition:blocked/parked` aliases to the flag fields', () => {
    expect(evaluate('disposition:blocked', engineItem)).toBe(true);
    expect(evaluate('disposition:parked', engineItem)).toBe(false);
    expect(evaluate('disposition:active', { ...engineItem, blocked: false })).toBe(true);
  });

  it('`pinned:` is deprecated — always false, with a parse-time warning', () => {
    expect(evaluate('pinned:true', engineItem)).toBe(false);
    expect(evaluate('pinned:false', engineItem)).toBe(true);
    const { warnings } = compileQuery('pinned:true', registry);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].field).toBe('pinned');
    expect(warnings[0].message).toMatch(/deprecated/i);
  });

  it('`phaseage:` emits a deprecation warning and evaluates as statusAge', () => {
    const { query, warnings } = compileQuery('phaseAge > 3d', registry);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].message).toMatch(/statusAge/);
    expect(query!.predicate(engineItem, { now })).toBe(true); // 5d statusAge fallback
  });

  it('warnings are collected through AND/OR/NOT nesting; clean queries carry none', () => {
    const { warnings } = compileQuery('status:draft AND (pinned:true OR NOT phaseAge > 1d)', registry);
    // `field` carries the query's authored casing (better for the user).
    expect(warnings.map((w) => w.field).sort()).toEqual(['phaseAge', 'pinned']);
    expect(compileQuery('status:draft AND phase:review', registry).warnings).toEqual([]);
  });

  // NOTE: the CLI-vs-browser dual-evaluator agreement test lives in
  // workflow-query-filter.test.ts (which imports the dashboard's
  // boardItemToQueryItem — a cross-import the tests-probe tsconfig cannot
  // typecheck, per its header note).

  it('queryFieldNames no longer advertises the deprecated pinned/phaseAge', async () => {
    const { queryFieldNames } = await import('../utils/fact-registry.js');
    const names = queryFieldNames([]);
    expect(names).not.toContain('pinned');
    expect(names).not.toContain('phaseAge');
    expect(names).toContain('phase');
    expect(names).toContain('statusAge');
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
