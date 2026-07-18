/**
 * The ONE seam that resolves which workflow a ticket belongs to and hands back
 * everything downstream needs to derive its status, gate its transitions, judge
 * terminality, and label its statuses — all from that ticket's OWN workflow.
 *
 * Every global-config derive/transition/terminal/label read site (CLI recompute,
 * dashboard projection, available-transitions, doctor, re-bind/delete scoping)
 * routes through {@link resolveAssignmentWorkflowContext} so per-workflow
 * behavior can never diverge across those surfaces. It composes the pure pieces:
 * `readProjectBinding` (project.md) + first-hit-wins `resolveWorkflowId` +
 * `getWorkflowBundle` + the shared `buildDeriveContext` + `buildTransitionTable`.
 *
 * Node-safe (reads project.md via `readProjectBinding`).
 */
import { readProjectBinding, type ProjectWorkflowBinding } from '../utils/project-binding.js';
import {
  getWorkflowBundle,
  getWorkflowLibrary,
  resolveWorkflowId,
} from '../utils/workflow-resolve.js';
import { loadWorkflowLibrary } from '../utils/workflow-library.js';
import { toTitleCase } from '../utils/status-defaults.js';
import { buildTransitionTable } from './state-machine.js';
import { buildDeriveContext, type DeriveContext } from './derive-context.js';
import type { StatusConfig, WorkflowDefinition } from '../utils/config.js';
import type { StageWorkflow } from '../utils/stage-model.js';

/** Minimal config shape the resolver needs: the workflow library, the legacy
 * `statuses` (for `default` synthesis), and the global default workflow id. The
 * full {@link import('../utils/config.js').SyntaurConfig} is assignable. */
export interface WorkflowConfigView {
  workflows?: Record<string, WorkflowDefinition> | null;
  statuses?: StatusConfig | null;
  defaultWorkflow?: string | null;
}

/** The binding-relevant subset of an assignment's frontmatter. */
export interface AssignmentBindingFields {
  workflow?: string | null;
  type?: string | null;
}

export interface WorkflowContext {
  /** The resolved workflow id this ticket belongs to. */
  workflowId: string;
  /** The resolved bundle (definitions/order/transitions/derive/facts + label). */
  bundle: WorkflowDefinition;
  /** Per-workflow derive context (rules, terminal/known sets, facts, registry). */
  deriveContext: DeriveContext;
  /** `from:command` → `to` table built from THIS workflow's transitions. */
  transitionTable: Map<string, string>;
  /** Terminal status ids for this workflow (mirror of `deriveContext`). */
  terminalStatuses: ReadonlySet<string>;
  /** All status ids defined by this workflow (mirror of `deriveContext`). */
  knownStatusIds: ReadonlySet<string>;
  /** Human label for a status id in this workflow; Title Case fallback. */
  statusLabel(id: string): string;
  /** The ticket's per-file {@link StageWorkflow} (WS-2), resolved against the
   * STAGE library (`loadWorkflowLibrary`) — NOT the legacy library — so a valid
   * per-file id doesn't fall to `default`. `null` when no per-file workflow
   * resolves (the dormant/legacy state, until WS-3 seeds workflows). Only
   * `forAssignment` populates it; `buildWorkflowContext` leaves it `null`. */
  stageWorkflow: StageWorkflow | null;
}

/**
 * Build the full context for a KNOWN workflow id. Pure and cheap-to-cache: keyed
 * only by (config, workflowId), so a sweep can memoize one context per id and
 * reuse the warm compile cache. Unknown ids synthesize the built-in default
 * bundle via {@link getWorkflowBundle}.
 */
export function buildWorkflowContext(
  config: WorkflowConfigView,
  workflowId: string,
): WorkflowContext {
  const bundle = getWorkflowBundle(config, workflowId);
  const deriveContext = buildDeriveContext(bundle);
  const labels = new Map(bundle.statuses.map((s) => [s.id, s.label] as const));
  return {
    workflowId,
    bundle,
    deriveContext,
    transitionTable: buildTransitionTable(bundle.transitions),
    terminalStatuses: deriveContext.terminalStatuses,
    knownStatusIds: deriveContext.knownStatusIds,
    statusLabel: (id) => labels.get(id) ?? toTitleCase(id),
    stageWorkflow: null, // legacy/id-cached path — the resolver's forAssignment attaches the real one
  };
}

const EMPTY_BINDING: ProjectWorkflowBinding = { defaultWorkflow: null, workflowByType: {} };

/**
 * The pure id-only resolution (no context build): apply first-hit-wins binding
 * precedence over the available workflow library. Shared by the async helper,
 * the sweep resolver, doctor, and re-bind scoping.
 */
export function resolveAssignmentWorkflowId(
  config: WorkflowConfigView,
  binding: ProjectWorkflowBinding,
  assignment: AssignmentBindingFields,
  /** Override the available-id set. Defaults to the LEGACY library (the ladder
   * resolution). WS-2 passes the STAGE library's keys so a valid per-file id
   * doesn't fall through to `default` (codex r4 finding 4). */
  available: ReadonlySet<string> = new Set(Object.keys(getWorkflowLibrary(config))),
): string {
  return resolveWorkflowId({
    assignmentWorkflow: assignment.workflow ?? null,
    assignmentType: assignment.type ?? null,
    projectDefaultWorkflow: binding.defaultWorkflow,
    projectWorkflowByType: binding.workflowByType,
    globalDefaultWorkflow: config.defaultWorkflow ?? null,
    available,
  });
}

export interface ResolveAssignmentWorkflowContextInput {
  /** The assignment's binding-relevant frontmatter (a full frontmatter is fine). */
  assignment: AssignmentBindingFields;
  /** Project dir to read the binding from (async). Ignored when `projectBinding` given. */
  projectDir?: string | null;
  /** Pre-read project binding — pass to skip the project.md read. */
  projectBinding?: ProjectWorkflowBinding | null;
  config: WorkflowConfigView;
}

/**
 * Resolve the full {@link WorkflowContext} for one assignment. Reads
 * `<projectDir>/project.md` for the binding when a pre-read `projectBinding` is
 * not supplied; standalone assignments (no project) resolve via the global/
 * built-in default.
 */
export async function resolveAssignmentWorkflowContext(
  input: ResolveAssignmentWorkflowContextInput,
): Promise<WorkflowContext> {
  const binding =
    input.projectBinding ??
    (input.projectDir ? await readProjectBinding(input.projectDir) : EMPTY_BINDING);
  const workflowId = resolveAssignmentWorkflowId(input.config, binding, input.assignment);
  return buildWorkflowContext(input.config, workflowId);
}

/**
 * Sweep-oriented resolver: build ONCE per config, then resolve many assignments.
 * Memoizes workflow contexts by id (so the compile-condition cache stays warm
 * across a `recomputeAll` sweep — Task 6) and project bindings by dir (so each
 * project's `project.md` is read at most once). Not concurrency-guarded — used
 * within a single sweep's sequential loop.
 */
export type WorkflowContextResolver = ReturnType<typeof makeWorkflowContextResolver>;

export function makeWorkflowContextResolver(config: WorkflowConfigView) {
  const contextCache = new Map<string, WorkflowContext>();
  const bindingCache = new Map<string, ProjectWorkflowBinding>();
  // Lazily-loaded per-file STAGE library (WS-2). `loadWorkflowLibrary` is itself
  // cached by workflowsDir signature; empty {} when no per-file workflows exist
  // (the dormant/legacy state) → stageWorkflow resolves to null.
  let stageLib: Record<string, StageWorkflow> | null = null;
  const stageLibrary = (): Record<string, StageWorkflow> => {
    if (stageLib === null) stageLib = loadWorkflowLibrary(config);
    return stageLib;
  };

  const context = (workflowId: string): WorkflowContext => {
    let ctx = contextCache.get(workflowId);
    if (!ctx) {
      ctx = buildWorkflowContext(config, workflowId);
      contextCache.set(workflowId, ctx);
    }
    return ctx;
  };

  /** Resolve the ticket's per-file StageWorkflow against the STAGE library's ids
   * (preserving `workflow:`/`type:` precedence), or null when none resolves. */
  const stageWorkflowFor = (
    assignment: AssignmentBindingFields,
    binding: ProjectWorkflowBinding,
  ): StageWorkflow | null => {
    const lib = stageLibrary();
    const ids = Object.keys(lib);
    if (ids.length === 0) return null;
    const id = resolveAssignmentWorkflowId(config, binding, assignment, new Set(ids));
    return lib[id] ?? null;
  };

  const bindingFor = async (projectDir: string | null): Promise<ProjectWorkflowBinding> => {
    if (!projectDir) return EMPTY_BINDING;
    let b = bindingCache.get(projectDir);
    if (!b) {
      b = await readProjectBinding(projectDir);
      bindingCache.set(projectDir, b);
    }
    return b;
  };

  return {
    context,
    bindingFor,
    /** Resolve the memoized context for an assignment in a given project. The
     * returned object spreads the id-cached legacy context and attaches THIS
     * ticket's `stageWorkflow` (resolved per-assignment against the stage
     * library) — so the shared cache is never polluted with a per-ticket field. */
    async forAssignment(
      assignment: AssignmentBindingFields,
      projectDir: string | null,
    ): Promise<WorkflowContext> {
      const binding = await bindingFor(projectDir);
      const base = context(resolveAssignmentWorkflowId(config, binding, assignment));
      const stageWorkflow = stageWorkflowFor(assignment, binding);
      return stageWorkflow === base.stageWorkflow ? base : { ...base, stageWorkflow };
    },
    /** Resolve just the per-file {@link StageWorkflow} for an assignment (WS-2
     * dependency-terminal-set resolution) — reads the project binding, resolves
     * against the stage library. `null` when no per-file workflow resolves. */
    async stageWorkflowFor(
      assignment: AssignmentBindingFields,
      projectDir: string | null,
    ): Promise<StageWorkflow | null> {
      return stageWorkflowFor(assignment, await bindingFor(projectDir));
    },
  };
}
