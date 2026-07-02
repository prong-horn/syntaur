/**
 * Pure, browser-safe workflow binding resolution — the single place the
 * first-hit-wins binding precedence lives. Consumed by both the Node lifecycle
 * (via the central `resolveAssignmentWorkflowContext` helper) and the dashboard
 * (board modes, filters), so it must stay free of Node imports.
 *
 * @see WorkflowDefinition in config.ts for the bundle shape.
 */
import type { StatusConfig, WorkflowDefinition } from './config.js';
import { buildDefaultStatusConfig, toTitleCase } from './status-defaults.js';

/** The built-in workflow id that is always resolvable (backward-compat anchor). */
export const DEFAULT_WORKFLOW_ID = 'default';

export interface ResolveWorkflowInput {
  /** `workflow:` on the assignment frontmatter — explicit override, wins. */
  assignmentWorkflow?: string | null;
  /** The assignment's `type:` — keys into the project's `workflowByType` map. */
  assignmentType?: string | null;
  /** Project `defaultWorkflow`. */
  projectDefaultWorkflow?: string | null;
  /** Project `workflowByType` map (type → workflow id). */
  projectWorkflowByType?: Record<string, string> | null;
  /** Global `defaultWorkflow` from config.md. */
  globalDefaultWorkflow?: string | null;
  /** The set of workflow ids that actually exist. Candidates not in this set
   * (deleted/renamed) are skipped so binding falls through gracefully. */
  available: ReadonlySet<string>;
}

/**
 * Resolve the workflow id for an assignment, first-hit-wins:
 *
 *   1. assignment `workflow:`         (explicit override)
 *   2. project `workflowByType[type]` (the type map)
 *   3. project `defaultWorkflow`
 *   4. global `defaultWorkflow`
 *   5. `'default'`                    (always terminates here)
 *
 * A candidate is skipped when it is empty or absent from {@link ResolveWorkflowInput.available}
 * — so a reference to a deleted/renamed workflow falls through to the next rung
 * rather than dangling. The final rung is the literal built-in `'default'`,
 * which is always resolvable by invariant.
 */
export function resolveWorkflowId(input: ResolveWorkflowInput): string {
  const {
    assignmentWorkflow,
    assignmentType,
    projectDefaultWorkflow,
    projectWorkflowByType,
    globalDefaultWorkflow,
    available,
  } = input;

  const typeMapped =
    assignmentType && projectWorkflowByType ? projectWorkflowByType[assignmentType] : null;

  const candidates = [
    assignmentWorkflow,
    typeMapped,
    projectDefaultWorkflow,
    globalDefaultWorkflow,
  ];

  for (const candidate of candidates) {
    if (candidate && available.has(candidate)) return candidate;
  }

  return DEFAULT_WORKFLOW_ID;
}

/**
 * Return the {@link WorkflowDefinition} for `id`. When the id is not present in
 * the library (the legacy no-`workflows:` case, or the `'default'` fallback),
 * synthesize it from the legacy single `statuses:` block if present, else from
 * the built-in default lifecycle — so callers always get a usable bundle.
 *
 * Accepts a minimal config shape so both the full `SyntaurConfig` and lighter
 * payloads can call it.
 */
export function getWorkflowBundle(
  config: {
    workflows?: Record<string, WorkflowDefinition> | null;
    statuses?: StatusConfig | null;
  },
  id: string,
): WorkflowDefinition {
  const existing = config.workflows?.[id];
  if (existing) return existing;

  const bundle = config.statuses ?? buildDefaultStatusConfig();
  const label = id === DEFAULT_WORKFLOW_ID ? 'Default' : toTitleCase(id);
  return { label, ...bundle };
}

/**
 * The effective workflow library as an in-memory map — the read-side of
 * backward-compat. When a `workflows:` block exists it is returned verbatim;
 * otherwise a legacy `statuses:`-only (or empty) config is presented as
 * `{ default: <synthesized bundle> }`. Purely in-memory — never mutates the
 * config file (the on-disk lift is `migrateStatusesToWorkflows`).
 */
export function getWorkflowLibrary(config: {
  workflows?: Record<string, WorkflowDefinition> | null;
  statuses?: StatusConfig | null;
}): Record<string, WorkflowDefinition> {
  if (config.workflows && Object.keys(config.workflows).length > 0) {
    return config.workflows;
  }
  return { [DEFAULT_WORKFLOW_ID]: getWorkflowBundle(config, DEFAULT_WORKFLOW_ID) };
}
