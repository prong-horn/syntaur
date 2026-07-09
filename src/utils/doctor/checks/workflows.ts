/**
 * Doctor check: every workflow binding references a workflow that actually
 * exists in the library. A dangling binding (project `defaultWorkflow` /
 * `workflowByType[type]`, global `defaultWorkflow`, or an assignment `workflow:`
 * override that names a workflow that was deleted or misspelled) silently
 * resolves to `default` at runtime — this surfaces it as an error instead so the
 * ticket lands where the author intended.
 */

import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileExists } from '../../fs.js';
import { getWorkflowLibrary, DEFAULT_WORKFLOW_ID } from '../../workflow-resolve.js';
import { loadWorkflowLibrary, loadWorkflowIssues } from '../../workflow-library.js';
import { readProjectBinding } from '../../project-binding.js';
import { listAssignmentsByProject } from '../../assignment-walk.js';
import { parseAssignmentFull } from '../../../dashboard/parser.js';
import { assignmentsDir as getStandaloneDir } from '../../paths.js';
import type { Check, CheckResult } from '../types.js';
import type { StageWorkflow } from '../../stage-model.js';

const CATEGORY = 'workflows';

// --- Structural validation of a per-file stage workflow (WS-0) ---------------
//
// Pure so it is trivially unit-testable and reusable by later workstreams. These
// are STRUCTURAL checks only (graph shape); gate *satisfiability* and the check
// vocabulary are the engine's concern (WS-1). Today the per-file library is
// empty (no live workflow file exists yet), so the doctor check that calls this
// passes vacuously until WS-3's migration relocates workflows.

/** Detect a cycle among `on: gate` (auto-advance) routes between known stages. */
function hasGateRouteCycle(wf: StageWorkflow): boolean {
  const stageIds = new Set(wf.stages.map((s) => s.id));
  const adjacency = new Map<string, string[]>();
  for (const s of wf.stages) {
    const outs: string[] = [];
    for (const r of s.next ?? []) {
      const trigger = r.on ?? 'gate'; // absent → gate (auto-advance)
      if (trigger === 'gate' && r.to && stageIds.has(r.to)) outs.push(r.to);
    }
    adjacency.set(s.id, outs);
  }
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  for (const id of adjacency.keys()) color.set(id, WHITE);
  const visit = (u: string): boolean => {
    color.set(u, GRAY);
    for (const v of adjacency.get(u) ?? []) {
      const c = color.get(v);
      if (c === GRAY) return true; // back-edge → cycle
      if (c === WHITE && visit(v)) return true;
    }
    color.set(u, BLACK);
    return false;
  };
  for (const id of adjacency.keys()) {
    if (color.get(id) === WHITE && visit(id)) return true;
  }
  return false;
}

/**
 * Every structural problem in one workflow (empty = sound):
 *   - no terminal stage;
 *   - a route / on-dissent / reopen targeting an unknown stage;
 *   - an unreachable non-entry stage (no route, on-dissent, or reopen leads in);
 *   - a gate entry with no predicate (neither `check` nor `condition`) — the WS-0
 *     structural slice of "gate references an unknown check"; semantic check-name
 *     validation arrives with the engine's check catalog (WS-1);
 *   - an auto-advance (`on: gate`) route cycle.
 */
export function findWorkflowStructureProblems(wf: StageWorkflow): string[] {
  const problems: string[] = [];
  const label = wf.id || '(unnamed)';
  const stageIds = new Set(wf.stages.map((s) => s.id).filter(Boolean));

  // Duplicate stage ids make a stored `status:` ambiguous — the Set above would
  // silently collapse them, so detect them explicitly first.
  const seenStageIds = new Set<string>();
  for (const s of wf.stages) {
    if (!s.id) continue;
    if (seenStageIds.has(s.id)) {
      problems.push(`workflow "${label}" has a duplicate stage id "${s.id}"`);
    } else {
      seenStageIds.add(s.id);
    }
  }

  if (!wf.stages.some((s) => s.terminal === true)) {
    problems.push(`workflow "${label}" has no terminal stage (mark one stage \`terminal: true\`)`);
  }

  // Build the reachability graph (any route/on-dissent/reopen edge to a known
  // stage) while validating targets and gate predicates.
  const adjacency = new Map<string, string[]>();
  for (const s of wf.stages) adjacency.set(s.id, []);
  for (const s of wf.stages) {
    const sid = s.id || '(unnamed)';
    const outs = adjacency.get(s.id)!;
    for (const r of s.next ?? []) {
      if (!r.to) continue;
      if (stageIds.has(r.to)) outs.push(r.to);
      else problems.push(`stage "${sid}" routes to unknown stage "${r.to}"`);
    }
    if (s.onDissent) {
      if (stageIds.has(s.onDissent)) outs.push(s.onDissent);
      else problems.push(`stage "${sid}" on-dissent target "${s.onDissent}" is not a stage`);
    }
    if (s.reopen) {
      if (stageIds.has(s.reopen)) outs.push(s.reopen);
      else problems.push(`stage "${sid}" reopen target "${s.reopen}" is not a stage`);
    }
    for (const g of s.gate ?? []) {
      if (!g.check && !g.condition) {
        problems.push(`stage "${sid}" has a gate entry with neither a 'check' nor a 'condition'`);
      }
    }
  }

  // Reachability from the entry stage (first stage). A stage can have an incoming
  // edge yet still be unreachable if it sits in a disconnected subgraph (e.g. a
  // separate cycle), so traverse from stages[0] rather than checking for any
  // incoming edge.
  if (wf.stages.length > 0) {
    const reachable = new Set<string>();
    const queue: string[] = [];
    const entry = wf.stages[0].id;
    if (entry) {
      reachable.add(entry);
      queue.push(entry);
    }
    while (queue.length > 0) {
      const u = queue.shift()!;
      for (const v of adjacency.get(u) ?? []) {
        if (!reachable.has(v)) {
          reachable.add(v);
          queue.push(v);
        }
      }
    }
    for (let i = 1; i < wf.stages.length; i++) {
      const s = wf.stages[i];
      if (s.id && !reachable.has(s.id)) {
        problems.push(`stage "${s.id}" is unreachable (no route path from the entry stage leads to it)`);
      }
    }
  }

  if (hasGateRouteCycle(wf)) {
    problems.push(`workflow "${label}" has an auto-advance (on: gate) route cycle`);
  }

  return problems;
}

const referencesResolve: Check = {
  id: 'workflows.references-resolve',
  category: CATEGORY,
  title: 'Workflow bindings reference defined workflows',
  async run(ctx): Promise<CheckResult> {
    const library = getWorkflowLibrary(ctx.config);
    const known = new Set(Object.keys(library));
    const problems: string[] = [];

    // The built-in default must always be resolvable — it is the terminal
    // fallback for every binding.
    if (!known.has(DEFAULT_WORKFLOW_ID)) {
      problems.push(`the built-in "${DEFAULT_WORKFLOW_ID}" workflow is missing from the library`);
    }
    if (ctx.config.defaultWorkflow && !known.has(ctx.config.defaultWorkflow)) {
      problems.push(
        `global defaultWorkflow "${ctx.config.defaultWorkflow}" is not a defined workflow`,
      );
    }

    // Per-project bindings.
    const projectsDir = ctx.config.defaultProjectDir;
    let projectNames: string[] = [];
    try {
      projectNames = await readdir(projectsDir);
    } catch {
      projectNames = [];
    }
    for (const name of projectNames) {
      const projectDir = resolve(projectsDir, name);
      if (!(await fileExists(resolve(projectDir, 'project.md')))) continue;
      const binding = await readProjectBinding(projectDir);
      if (binding.defaultWorkflow && !known.has(binding.defaultWorkflow)) {
        problems.push(
          `project ${name}: defaultWorkflow "${binding.defaultWorkflow}" is not a defined workflow`,
        );
      }
      for (const [type, wf] of Object.entries(binding.workflowByType)) {
        if (!known.has(wf)) {
          problems.push(
            `project ${name}: workflowByType[${type}] = "${wf}" is not a defined workflow`,
          );
        }
      }
    }

    // Per-assignment overrides.
    const { withAssignmentMd } = await listAssignmentsByProject(projectsDir, getStandaloneDir());
    for (const a of withAssignmentMd) {
      try {
        const parsed = parseAssignmentFull(
          await readFile(resolve(a.assignmentDir, 'assignment.md'), 'utf-8'),
        );
        if (parsed.workflow && !known.has(parsed.workflow)) {
          const where = a.projectSlug ? `${a.projectSlug}/${a.assignmentSlug}` : a.assignmentSlug;
          problems.push(`${where}: workflow "${parsed.workflow}" is not a defined workflow`);
        }
      } catch {
        // A malformed assignment.md is the assignment checks' concern, not ours.
      }
    }

    if (problems.length === 0) {
      return {
        id: this.id,
        category: this.category,
        title: this.title,
        status: 'pass',
        detail: `${known.size} workflow(s) defined; all bindings resolve`,
        autoFixable: false,
      };
    }

    return {
      id: this.id,
      category: this.category,
      title: this.title,
      status: 'error',
      detail: problems.join('; '),
      affected: problems,
      remediation: {
        kind: 'manual',
        suggestion:
          'Define the missing workflow(s) under `workflows:` in ~/.syntaur/config.md, or fix the binding to name an existing workflow id.',
        command: null,
      },
      autoFixable: false,
    };
  },
};

/**
 * Doctor check: config.md must not carry BOTH a top-level `statuses:` block and a
 * `workflows:` map. The multi-workflow migration lifts the legacy block into
 * `workflows.default`; if `syntaur status init` (or a hand edit) recreates the
 * top-level block, `getWorkflowLibrary` ignores it while `syntaur status` (before
 * this fix) would edit it — the two sources silently diverge.
 */
const singleStatusSource: Check = {
  id: 'workflows.single-status-source',
  category: CATEGORY,
  title: 'Single status source (no legacy statuses: block alongside workflows:)',
  async run(ctx): Promise<CheckResult> {
    const hasWorkflows = !!ctx.config.workflows && Object.keys(ctx.config.workflows).length > 0;

    // Detect a PHYSICALLY present top-level `statuses:` block, NOT
    // `config.statuses !== null` — parseStatusConfig returns null for an
    // empty/unparseable block, which is still a colliding second source. Mirror
    // parseStatusConfig EXACTLY (config.ts:668,673): extract the frontmatter
    // fence, then match the anchored `^statuses:\s*$` only within it — so a
    // column-0 `statuses:` in the markdown body, or an inline `statuses: x`
    // that the parser ignores, cannot produce a false-positive error here.
    const configFile = resolve(ctx.syntaurRoot, 'config.md');
    let hasLegacyBlock = false;
    if (await fileExists(configFile)) {
      const raw = await readFile(configFile, 'utf-8');
      const fm = raw.match(/^---\n([\s\S]*?)\n---/);
      hasLegacyBlock = fm !== null && /^statuses:\s*$/m.test(fm[1]);
    }

    if (hasWorkflows && hasLegacyBlock) {
      return {
        id: this.id,
        category: this.category,
        title: this.title,
        status: 'error',
        detail:
          'config.md has BOTH a top-level `statuses:` block and a `workflows:` map. The ' +
          '`workflows:` map is authoritative (getWorkflowLibrary ignores the legacy block), so ' +
          'the two sources silently diverge.',
        remediation: {
          kind: 'manual',
          suggestion:
            'Delete the top-level `statuses:` block from ~/.syntaur/config.md — the `workflows:` map (including the `default` workflow) is the single source of truth.',
          command: null,
        },
        autoFixable: false,
      };
    }

    return {
      id: this.id,
      category: this.category,
      title: this.title,
      status: 'pass',
      detail: hasWorkflows
        ? 'single status source (workflows: map)'
        : hasLegacyBlock
          ? 'single status source (legacy statuses: block)'
          : 'no custom status config (built-in defaults)',
      autoFixable: false,
    };
  },
};

/**
 * Doctor check: the per-file dir and a `config.md` block must never both be
 * live — the {@link loadWorkflowLibrary} single-source invariant (§4.6, WS-0.4)
 * surfaced as a check. Complements the Phase-0 `single-status-source` (which
 * guards two blocks *inside* config.md) by guarding the dir-vs-config split.
 */
const perFileSingleSource: Check = {
  id: 'workflows.single-workflow-source',
  category: CATEGORY,
  title: 'Single workflow source (no ~/.syntaur/workflows/ dir alongside a config.md block)',
  async run(ctx): Promise<CheckResult> {
    try {
      loadWorkflowLibrary(ctx.config);
    } catch (err) {
      return {
        id: this.id,
        category: this.category,
        title: this.title,
        status: 'error',
        detail: err instanceof Error ? err.message : String(err),
        remediation: {
          kind: 'manual',
          suggestion:
            'Relocate to a single source: run `syntaur migrate-workflows`, or delete the `workflows:`/`statuses:` block from ~/.syntaur/config.md once the per-file dir is authoritative.',
          command: null,
        },
        autoFixable: false,
      };
    }
    return {
      id: this.id,
      category: this.category,
      title: this.title,
      status: 'pass',
      detail: 'single workflow source',
      autoFixable: false,
    };
  },
};

/**
 * Doctor check: every per-file stage workflow is structurally sound (see
 * {@link findWorkflowStructureProblems}). Vacuously passes until per-file
 * workflows exist (WS-3). Skips when the library is unreadable — that dual-source
 * condition is reported by `workflows.single-workflow-source`.
 */
const stageStructure: Check = {
  id: 'workflows.stage-structure',
  category: CATEGORY,
  title: 'Per-file stage workflows are structurally sound',
  async run(ctx): Promise<CheckResult> {
    let library: Record<string, StageWorkflow>;
    try {
      library = loadWorkflowLibrary(ctx.config);
    } catch {
      return {
        id: this.id,
        category: this.category,
        title: this.title,
        status: 'skipped',
        detail: 'per-file library unreadable (see workflows.single-workflow-source)',
        autoFixable: false,
      };
    }

    const ids = Object.keys(library);
    const problems: string[] = [];

    // Surface the parser's own issues (missing `id:`, malformed fields it
    // preserved on `raw`, …) — otherwise a file that parsed-with-problems would
    // pass silently. Shares the loader cache, so no extra disk read.
    const parseIssues = loadWorkflowIssues(ctx.config);
    for (const [stem, msgs] of Object.entries(parseIssues)) {
      for (const m of msgs) problems.push(`${stem}.md: ${m}`);
    }

    for (const id of ids) {
      const wf = library[id];
      // The map key is the filename stem (the authoritative id). A mismatched
      // internal `id:` would confuse bindings / rendering — flag it.
      if (wf.id && wf.id !== id) {
        problems.push(`workflow file "${id}.md" declares id "${wf.id}" (must match its filename)`);
      }
      problems.push(...findWorkflowStructureProblems(wf));
    }

    if (problems.length === 0) {
      return {
        id: this.id,
        category: this.category,
        title: this.title,
        status: 'pass',
        detail:
          ids.length === 0
            ? 'no per-file stage workflows defined'
            : `${ids.length} per-file workflow(s) structurally sound`,
        autoFixable: false,
      };
    }

    return {
      id: this.id,
      category: this.category,
      title: this.title,
      status: 'error',
      detail: problems.join('; '),
      affected: problems,
      remediation: {
        kind: 'manual',
        suggestion:
          'Fix the workflow file(s) under ~/.syntaur/workflows/: add a terminal stage, point routes at defined stages, remove unreachable stages / auto-advance cycles, and give every gate entry a check or condition.',
        command: null,
      },
      autoFixable: false,
    };
  },
};

export const workflowsChecks: Check[] = [
  referencesResolve,
  singleStatusSource,
  perFileSingleSource,
  stageStructure,
];
