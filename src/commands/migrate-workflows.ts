/**
 * `syntaur migrate-workflows` — the one-time, idempotent WS-3 migration that
 * turns the stage engine ON for real data (design §4). Mirrors
 * `migrate-derive.ts` (precondition → target walk → dry-run vs locked apply →
 * divergence report → apply-only marker). In one apply it:
 *
 *   1. RELOCATES the `config.md` `workflows:` entries to per-file
 *      `~/.syntaur/workflows/<id>.md` — the derive-ladder-governed `default`
 *      COMPILED via `ladder-compile.ts`; any transitions-block workflow (live:
 *      `test`) relocated verbatim as manual-only (decision D1) — and STRIPS the
 *      whole `workflows:` block in the same apply (§4.6 exclusivity), as a
 *      resumable state machine (a crash at any point heals on re-run);
 *   2. SEEDS every non-terminal ticket's stored stage position
 *      (`stage := phase ?? last-non-flag statusHistory.to ?? placeTicket()`,
 *      validated) while preserving terminal tickets' `status` VERBATIM;
 *   3. REMAPS the `blocked`/`parked` pause statuses to their real stage with
 *      `blockedReason`/`parked` preserved (the flag re-derives from them);
 *   4. sets the `stages-migrated` marker ONLY on a fully-successful apply.
 *
 * **`--root` isolation.** Every path helper resolves through
 * `process.env.SYNTAUR_HOME` (read per call), so it is set from `--root`
 * BEFORE any config/helper touch; the projects/standalone dirs derive from
 * `<root>` directly — never from the copied config's absolute
 * `defaultProjectDir`, which points back at the REAL root.
 *
 * **The migration-only locked writer.** Pre-marker, `recomputeAndWrite` runs
 * the LADDER derive branch, which would overwrite a seeded stage with a
 * ladder-derived status (and re-derive the blocked ticket back to `blocked`).
 * All per-ticket writes here go through {@link migrationWrite} — the same
 * `acquireLock` + content-CAS discipline, with NO dimension derivation.
 */

import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  deleteLegacyStatusesBlock,
  deleteWorkflowsConfig,
  readConfig,
  type StatusConfig,
  type WorkflowDefinition,
} from '../utils/config.js';
import { expandHome, syntaurRoot } from '../utils/paths.js';
import { fileExists, writeFileForce } from '../utils/fs.js';
import { getWorkflowBundle, getWorkflowLibrary, DEFAULT_WORKFLOW_ID } from '../utils/workflow-resolve.js';
import { setDefaultWorkflowPointer, writeWorkflowFile } from '../utils/workflow-write.js';
import { serializeWorkflowFile, workflowFilePath } from '../utils/workflow-file.js';
import { readProjectBinding, type ProjectWorkflowBinding } from '../utils/project-binding.js';
import type { StageWorkflow, WorkflowStage } from '../utils/stage-model.js';
import {
  compileLadderWorkflow,
  type LadderCompileReport,
} from '../lifecycle/ladder-compile.js';
import { buildDeriveContext, type DeriveContext } from '../lifecycle/derive-context.js';
import { resolveAssignmentWorkflowId } from '../lifecycle/workflow-context.js';
import { computeFacts } from '../lifecycle/facts.js';
import { placeTicket, type EngineInput } from '../lifecycle/stage-engine.js';
import {
  parseAssignmentFrontmatter,
  renameStatusInHistory,
  updateAssignmentFile,
} from '../lifecycle/frontmatter.js';
import { acquireLock, contentHash, markStagesMigrated } from '../lifecycle/recompute.js';

export interface MigrateWorkflowsOptions {
  /** Migrate this syntaur home instead of `~/.syntaur` (a COPY for the gated
   * live dry-run). Sets `SYNTAUR_HOME` before anything touches disk. */
  root?: string;
  /** Report the full compile + divergence report without writing anything. */
  dryRun?: boolean;
}

const CAS_RETRIES = 3;

interface DivergenceRow {
  ref: string;
  before: string;
  after: string;
  kind: 'preserved-terminal' | 'unchanged' | 'seeded' | 'remapped';
  note?: string;
}

// ── The migration-only locked writer (T3) ────────────────────────────────────

/**
 * Lock + CAS write with NO dimension derivation: `mutate` receives the fresh
 * locked content and returns the next content (or the same string for a
 * no-op). All T4/T5 per-ticket writes ride this — never `recomputeAndWrite`,
 * whose pre-marker ladder branch would re-derive over the seeded stage.
 */
async function migrationWrite(
  assignmentPath: string,
  mutate: (content: string) => string,
): Promise<'written' | 'unchanged'> {
  const release = await acquireLock(resolve(assignmentPath, '..'));
  try {
    for (let attempt = 0; attempt < CAS_RETRIES; attempt++) {
      const original = await readFile(assignmentPath, 'utf-8');
      const next = mutate(original);
      if (next === original) return 'unchanged';
      const current = await readFile(assignmentPath, 'utf-8');
      if (contentHash(current) !== contentHash(original)) continue;
      await writeFileForce(assignmentPath, next);
      return 'written';
    }
    throw new Error(`migration write skipped after ${CAS_RETRIES} concurrent-edit retries: ${assignmentPath}`);
  } finally {
    await release();
  }
}

// ── Manual-only relocation (T4, decision D1) ─────────────────────────────────

/**
 * Relocate a transitions-block (state machine) workflow verbatim as a
 * MANUAL-ONLY {@link StageWorkflow}: its definitions become stages (label /
 * color / terminal carried; description preserved on `raw`), with NO gates and
 * NO routes — movement is manual until a human authors gates/routes (or
 * deletes it). The legacy `transitions:` block is preserved verbatim as an
 * unknown top-level key (no silent deletion); `terminal_failure` maps from the
 * `fail` transition target so the fail verb stays honest if ever activated.
 */
export function buildManualOnlyWorkflow(id: string, bundle: WorkflowDefinition): StageWorkflow {
  const defined = bundle.statuses.map((s) => s.id);
  const ordered = [
    ...bundle.order.filter((sid) => defined.includes(sid)),
    ...defined.filter((sid) => !bundle.order.includes(sid)),
  ];
  const byId = new Map(bundle.statuses.map((s) => [s.id, s] as const));
  const stages: WorkflowStage[] = ordered.map((sid) => {
    const def = byId.get(sid)!;
    const stage: WorkflowStage = { id: def.id };
    if (def.label) stage.label = def.label;
    if (def.color) stage.color = def.color;
    if (def.terminal) stage.terminal = true;
    const raw: Record<string, unknown> = {};
    if (def.description) raw.description = def.description;
    if (def.icon) raw.icon = def.icon;
    if (Object.keys(raw).length > 0) stage.raw = raw;
    return stage;
  });
  const workflow: StageWorkflow = { id, stages };
  if (bundle.label) workflow.label = bundle.label;
  const terminalSet = new Set(bundle.statuses.filter((s) => s.terminal).map((s) => s.id));
  const fail = (bundle.transitions ?? []).find((t) => t.command === 'fail' && terminalSet.has(t.to));
  if (fail) workflow.terminalFailure = fail.to;
  if ((bundle.transitions ?? []).length > 0) {
    workflow.raw = { transitions: bundle.transitions };
  }
  return workflow;
}

// ── Expected per-file set ────────────────────────────────────────────────────

interface ExpectedWorkflow {
  id: string;
  workflow: StageWorkflow;
  content: string;
  /** How it was produced — drives the report + seeding semantics. */
  mode: 'compiled' | 'manual-only';
  report?: LadderCompileReport;
}

/**
 * The per-file workflows this migration must converge to: the ladder-governed
 * `default` (and any other transitions-less workflow) COMPILED; any
 * transitions-block workflow relocated manual-only (D1 — no transitions→stages
 * compiler).
 */
function buildExpectedWorkflows(config: {
  workflows?: Record<string, WorkflowDefinition> | null;
  statuses?: StatusConfig | null;
}): ExpectedWorkflow[] {
  const library = getWorkflowLibrary(config);
  const out: ExpectedWorkflow[] = [];
  for (const [id, bundle] of Object.entries(library)) {
    const isStateMachine = id !== DEFAULT_WORKFLOW_ID && (bundle.transitions ?? []).length > 0;
    if (isStateMachine) {
      const workflow = buildManualOnlyWorkflow(id, bundle);
      out.push({ id, workflow, content: serializeWorkflowFile(workflow), mode: 'manual-only' });
    } else {
      const { workflow, report } = compileLadderWorkflow(id, bundle);
      out.push({ id, workflow, content: serializeWorkflowFile(workflow), mode: 'compiled', report });
    }
  }
  return out;
}

// ── Target walk (mirrors migrate-derive.ts, incl. standalone) ────────────────

async function listTargets(
  projectsDir: string,
  standaloneDir: string,
): Promise<Array<{ path: string; projectDir: string | null; ref: string }>> {
  const targets: Array<{ path: string; projectDir: string | null; ref: string }> = [];
  let projects: string[] = [];
  try {
    projects = await readdir(projectsDir);
  } catch {
    /* none */
  }
  for (const project of projects) {
    const projectDir = resolve(projectsDir, project);
    let slugs: string[] = [];
    try {
      slugs = await readdir(resolve(projectDir, 'assignments'));
    } catch {
      continue;
    }
    for (const slug of slugs) {
      const path = resolve(projectDir, 'assignments', slug, 'assignment.md');
      if (await fileExists(path)) targets.push({ path, projectDir, ref: `${project}/${slug}` });
    }
  }
  let ids: string[] = [];
  try {
    ids = await readdir(standaloneDir);
  } catch {
    /* none */
  }
  for (const id of ids) {
    const path = resolve(standaloneDir, id, 'assignment.md');
    if (await fileExists(path)) targets.push({ path, projectDir: null, ref: id });
  }
  return targets;
}

// ── Seeding decisions (T5, computed in a pure pre-pass) ──────────────────────

interface SeedDecision {
  target: { path: string; projectDir: string | null; ref: string };
  row: DivergenceRow;
  /** The stage to write (absent for preserved/unchanged rows). */
  stage?: string;
  /** The pause status being remapped (relabel history + preserve reason). */
  remapFrom?: string;
}

/** The pause-flag status ids for a workflow (per-ticket remap targets). */
function flagStatusIds(ctx: DeriveContext): Set<string> {
  const ids = new Set<string>();
  for (const rule of ctx.derive.disposition) {
    if (rule.when !== null && rule.is !== 'active') ids.add(rule.is);
  }
  ids.add(ctx.derive.headline.parked);
  ids.add(ctx.derive.headline.blocked);
  return ids;
}

/** Exported for the test suite (the invalid-seed abort path is unreachable
 * through a well-formed live config, but must abort before the marker). */
export async function computeSeedDecision(
  target: { path: string; projectDir: string | null; ref: string },
  content: string,
  workflow: StageWorkflow,
  ctx: DeriveContext,
): Promise<SeedDecision | { error: string }> {
  const fm = parseAssignmentFrontmatter(content);

  // Terminal preservation (round-1 blocker 2): `status` verbatim, NEVER
  // reseeded from `phase` (89 live completed tickets carry `phase: review`).
  if (ctx.terminalStatuses.has(fm.status)) {
    return {
      target,
      row: { ref: target.ref, before: fm.status, after: fm.status, kind: 'preserved-terminal' },
    };
  }

  const stageIds = new Set(workflow.stages.map((s) => s.id));
  const flags = flagStatusIds(ctx);

  // stage := phase ?? last-non-flag statusHistory.to ?? placeTicket() — each
  // candidate validated against the compiled stage set; an orphan/deleted id
  // falls through to the next candidate.
  let stage: string | null = null;
  if (fm.phase && stageIds.has(fm.phase)) stage = fm.phase;
  if (stage === null) {
    const lastNonFlag = [...fm.statusHistory].reverse().find((e) => e.to && !flags.has(e.to));
    if (lastNonFlag && stageIds.has(lastNonFlag.to)) stage = lastNonFlag.to;
  }
  if (stage === null) {
    const body = content.replace(/^---\n[\s\S]*?\n---/, '');
    const facts = await computeFacts({
      assignmentDir: resolve(target.path, '..'),
      frontmatter: fm,
      body,
      projectDir: target.projectDir,
      terminalStatuses: ctx.terminalStatuses,
      declarations: ctx.factDeclarations,
    });
    const input: EngineInput = {
      facts,
      evidence: {},
      firedDissents: new Set(),
      registry: ctx.registry,
    };
    stage = placeTicket(workflow, input);
  }
  // An invalid FINAL candidate aborts the whole apply before the marker (T6).
  if (!stage || !stageIds.has(stage)) {
    return {
      error: `${target.ref}: no valid seed stage (phase: ${fm.phase ?? 'null'}, status: ${fm.status}) — aborting before the marker`,
    };
  }

  if (fm.status === stage && fm.phase === stage) {
    return { target, row: { ref: target.ref, before: fm.status, after: stage, kind: 'unchanged' } };
  }
  const isRemap = flags.has(fm.status);
  return {
    target,
    stage,
    ...(isRemap ? { remapFrom: fm.status } : {}),
    row: {
      ref: target.ref,
      before: fm.status,
      after: stage,
      kind: isRemap ? 'remapped' : 'seeded',
      ...(isRemap ? { note: 'pause state → flag; blockedReason/parked preserved' } : {}),
    },
  };
}

// ── The command ──────────────────────────────────────────────────────────────

export async function migrateWorkflowsCommand(options: MigrateWorkflowsOptions): Promise<void> {
  // `--root` isolation (round-2 major 5): set SYNTAUR_HOME BEFORE any
  // readConfig()/helper call — paths.ts reads it per call, so every helper
  // (config, marker, per-file workflows, locks) resolves under <root>.
  process.env.SYNTAUR_HOME = resolve(expandHome(options.root ?? syntaurRoot()));
  const root = syntaurRoot();
  // Projects + standalone dirs derive from <root> DIRECTLY — the copied
  // config.md carries an absolute `defaultProjectDir` pointing at the REAL root.
  const projectsDir = resolve(root, 'projects');
  const standaloneDir = resolve(root, 'assignments');

  const config = await readConfig();
  const originalDefault = config.defaultWorkflow ?? DEFAULT_WORKFLOW_ID;
  const expected = buildExpectedWorkflows(config);

  // ── Compile report (T1/T2 output + D1 note) — printed in BOTH modes ───────
  const mode = options.dryRun ? '[dry-run] ' : '';
  for (const wf of expected) {
    if (wf.mode === 'manual-only') {
      console.log(
        `${mode}workflow "${wf.id}": transitions block (state machine) → relocated verbatim, MANUAL-ONLY ` +
          `(decision D1 — a human must author gates/routes, or delete it; it may simply be deletable).`,
      );
      continue;
    }
    const r = wf.report!;
    console.log(`${mode}workflow "${wf.id}": compiled from the derive ladder.`);
    for (const d of r.decisions) {
      const verb = d.verb ? ` (verb: ${d.verb})` : '';
      console.log(`  [${d.from} → ${d.to}] ${d.conjunct} → ${d.outcome}${verb} — ${d.reason}`);
    }
    for (const o of r.orphans) {
      console.log(`  ORPHAN "${o.id}" → ${o.decision}: ${o.reason}`);
    }
    console.log(`  terminals: ${r.terminals.join(', ')}`);
    console.log(
      `  flags: ${Object.entries(r.flags)
        .map(([n, w]) => (w ? `${n}(when: ${w})` : `${n}(manual)`))
        .join(', ')}`,
    );
    console.log(`  caveat: ${r.caveat}`);
  }

  // ── Relocation state machine, step 1 pre-check: never clobber a hand-edited
  //    per-file workflow (round-2 blocker 1) ─────────────────────────────────
  const missing: ExpectedWorkflow[] = [];
  for (const wf of expected) {
    const path = workflowFilePath(wf.id);
    if (!(await fileExists(path))) {
      missing.push(wf);
      continue;
    }
    const existing = await readFile(path, 'utf-8');
    if (existing !== wf.content) {
      throw new Error(
        `per-file workflow ${path} exists and DIFFERS from the expected relocation — ` +
          `refusing to clobber a hand-edited file. Resolve (delete or reconcile) and re-run.`,
      );
    }
  }

  // ── Seeding pre-pass (T5): compute EVERY decision before any write, so an
  //    invalid seed aborts the apply before anything mutates (T6) ────────────
  const contextByWorkflow = new Map<string, DeriveContext>();
  const contextFor = (workflowId: string): DeriveContext => {
    let ctx = contextByWorkflow.get(workflowId);
    if (!ctx) {
      ctx = buildDeriveContext(getWorkflowBundle(config, workflowId));
      contextByWorkflow.set(workflowId, ctx);
    }
    return ctx;
  };
  const workflowById = new Map(expected.map((e) => [e.id, e.workflow] as const));
  const availableIds = new Set(workflowById.keys());
  const bindingCache = new Map<string, ProjectWorkflowBinding>();
  const bindingFor = async (projectDir: string | null): Promise<ProjectWorkflowBinding> => {
    if (!projectDir) return { defaultWorkflow: null, workflowByType: {} };
    let b = bindingCache.get(projectDir);
    if (!b) {
      b = await readProjectBinding(projectDir);
      bindingCache.set(projectDir, b);
    }
    return b;
  };

  const targets = await listTargets(projectsDir, standaloneDir);
  const decisions: SeedDecision[] = [];
  const errors: string[] = [];
  for (const target of targets) {
    let content: string;
    try {
      content = await readFile(target.path, 'utf-8');
    } catch {
      continue;
    }
    const fm = parseAssignmentFrontmatter(content);
    const binding = await bindingFor(target.projectDir);
    const workflowId = resolveAssignmentWorkflowId(config, binding, fm, availableIds);
    const workflow = workflowById.get(workflowId);
    if (!workflow) {
      errors.push(`${target.ref}: resolves to workflow "${workflowId}" which has no relocated file`);
      continue;
    }
    const decision = await computeSeedDecision(target, content, workflow, contextFor(workflowId));
    if ('error' in decision) errors.push(decision.error);
    else decisions.push(decision);
  }

  if (errors.length > 0) {
    console.error(`\n${mode}INVALID SEEDS — the apply is aborted BEFORE the marker:`);
    for (const e of errors) console.error(`  ${e}`);
    throw new Error(`migrate-workflows: ${errors.length} invalid seed candidate(s); nothing was migrated.`);
  }

  const rows = decisions.map((d) => d.row);
  const counts = {
    preserved: rows.filter((r) => r.kind === 'preserved-terminal').length,
    unchanged: rows.filter((r) => r.kind === 'unchanged').length,
    seeded: rows.filter((r) => r.kind === 'seeded').length,
    remapped: rows.filter((r) => r.kind === 'remapped').length,
  };

  if (options.dryRun) {
    printDivergenceReport(rows, mode);
    console.log(
      `${mode}migrate-workflows: ${targets.length} assignment(s) scanned — ` +
        `${counts.preserved} terminal (preserved verbatim), ${counts.unchanged} already in place, ` +
        `${counts.seeded} would seed, ${counts.remapped} would remap; ` +
        `${missing.length} per-file workflow(s) would be written; marker NOT set.`,
    );
    return;
  }

  // ── Apply: relocation (T4) ────────────────────────────────────────────────
  // 1. Per-file convergence — write each missing file (present+matching were
  //    verified above; differing already aborted).
  for (const wf of missing) {
    await writeWorkflowFile(wf.workflow);
    console.log(`wrote ${workflowFilePath(wf.id)}`);
  }
  // 2. Strip the whole `workflows:` block (idempotent) — and any legacy
  //    `statuses:` block, which equally bricks the per-file loader (§4.6).
  await deleteWorkflowsConfig();
  await deleteLegacyStatusesBlock();
  // 3. Always ensure the default pointer scalar (deleteWorkflowsConfig strips
  //    it) — idempotent, heals the strip-then-crash partial state.
  await setDefaultWorkflowPointer(originalDefault);

  // ── Apply: seeding + pause remap via the migration-only writer (T5) ───────
  // Terminal race guard: if a ticket reached a terminal status between the
  // pre-pass and the locked write, preserve it verbatim (any workflow's set).
  const isAnyTerminal = (status: string): boolean => {
    for (const ctx of contextByWorkflow.values()) if (ctx.terminalStatuses.has(status)) return true;
    return false;
  };
  for (const d of decisions) {
    if (!d.stage) continue;
    const stage = d.stage;
    const remapFrom = d.remapFrom;
    await migrationWrite(d.target.path, (fresh) => {
      const freshFm = parseAssignmentFrontmatter(fresh);
      if (isAnyTerminal(freshFm.status)) return fresh; // raced to terminal — preserve
      let next = fresh;
      if (freshFm.status !== stage || freshFm.phase !== stage) {
        next = updateAssignmentFile(next, { status: stage, phase: stage });
      }
      // Pause-state remap: relabel history (`blocked`/`parked` cease to be
      // status ids); `blockedReason`/`parked` are NOT touched — the flag
      // re-derives from them under the workflow's flag definitions.
      if (remapFrom) next = renameStatusInHistory(next, remapFrom, stage);
      return next;
    });
  }

  // ── Marker (T6): only after a fully-successful apply ──────────────────────
  await markStagesMigrated();

  printDivergenceReport(rows, mode);
  console.log(
    `migrate-workflows: ${targets.length} assignment(s) scanned — ` +
      `${counts.preserved} terminal (preserved verbatim), ${counts.unchanged} already in place, ` +
      `${counts.seeded} seeded, ${counts.remapped} remapped; ` +
      `${expected.length} per-file workflow(s) in place, config block removed, ` +
      `stages-migrated marker SET.`,
  );
}

function printDivergenceReport(rows: DivergenceRow[], mode: string): void {
  const interesting = rows.filter((r) => r.kind !== 'unchanged');
  if (interesting.length === 0) return;
  console.log(`\n${mode}Divergence report (stored → seeded stage):`);
  for (const r of interesting) {
    const note = r.note ? ` — ${r.note}` : '';
    if (r.kind === 'preserved-terminal') {
      console.log(`  ${r.ref}: ${r.before} (terminal — preserved)`);
    } else {
      console.log(`  ${r.ref}: ${r.before} → ${r.after} [${r.kind}]${note}`);
    }
  }
}
