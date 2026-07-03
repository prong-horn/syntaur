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
import { toTitleCase } from '../utils/status-defaults.js';
import { buildTransitionTable } from './state-machine.js';
import { buildDeriveContext, type DeriveContext } from './derive-context.js';
import type { StatusConfig, WorkflowDefinition } from '../utils/config.js';

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
): string {
  const available = new Set(Object.keys(getWorkflowLibrary(config)));
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

  const context = (workflowId: string): WorkflowContext => {
    let ctx = contextCache.get(workflowId);
    if (!ctx) {
      ctx = buildWorkflowContext(config, workflowId);
      contextCache.set(workflowId, ctx);
    }
    return ctx;
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
    /** Resolve the memoized context for an assignment in a given project. */
    async forAssignment(
      assignment: AssignmentBindingFields,
      projectDir: string | null,
    ): Promise<WorkflowContext> {
      const binding = await bindingFor(projectDir);
      return context(resolveAssignmentWorkflowId(config, binding, assignment));
    },
  };
}
