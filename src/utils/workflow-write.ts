/**
 * Node-only write helpers for the multi-workflow library. These sit above
 * `writeWorkflowsConfig` (config.ts) and `getWorkflowLibrary` (workflow-resolve.ts)
 * and are the single lift point where writes first introduce the `workflows:`
 * block: on the first per-workflow write to a legacy single-config, the existing
 * top-level `statuses:` block is captured as `workflows.default` and then
 * deleted (Decision D4). Kept in their own module to avoid a config ⇄
 * workflow-resolve import cycle (config.ts must not import workflow-resolve).
 */

import {
  readConfig,
  writeStatusConfig,
  writeWorkflowsConfig,
  deleteLegacyStatusesBlock,
  type StatusConfig,
  type WorkflowDefinition,
} from './config.js';
import { getWorkflowLibrary, DEFAULT_WORKFLOW_ID } from './workflow-resolve.js';
import { toTitleCase } from './status-defaults.js';

function hasWorkflowsBlock(config: {
  workflows?: Record<string, WorkflowDefinition> | null;
}): boolean {
  return !!config.workflows && Object.keys(config.workflows).length > 0;
}

/** Was the config still legacy (top-level `statuses:`, no `workflows:` map)? */
function hasLegacyStatusesOnly(config: {
  statuses?: StatusConfig | null;
  workflows?: Record<string, WorkflowDefinition> | null;
}): boolean {
  return !hasWorkflowsBlock(config) && !!config.statuses;
}

export interface WriteWorkflowBundleOptions {
  /** Override the workflow's display label (defaults to the existing label, or
   * `'Default'` / Title-Cased id for a new workflow). */
  label?: string;
  /** Promote this workflow to the global `defaultWorkflow` as part of the write. */
  setDefault?: boolean;
}

/**
 * Upsert one workflow's status bundle into `workflows.<id>`, preserving every
 * other workflow and the current `defaultWorkflow` (unless `setDefault`). Lifts
 * and deletes a legacy `statuses:` block on first write (D4).
 */
export async function writeWorkflowBundle(
  workflowId: string,
  bundle: StatusConfig,
  opts: WriteWorkflowBundleOptions = {},
): Promise<void> {
  const config = await readConfig();

  // Editing the DEFAULT workflow of a still-legacy config keeps the legacy
  // top-level `statuses:` format — a single-workflow config never grows a
  // `workflows:` block just from status-settings edits. The block (and the D4
  // lift+delete) is introduced only when a real, non-default workflow is
  // created below, or when one already exists.
  if (!hasWorkflowsBlock(config) && workflowId === DEFAULT_WORKFLOW_ID && !opts.setDefault) {
    await writeStatusConfig(bundle);
    return;
  }

  const wasLegacy = hasLegacyStatusesOnly(config);

  // getWorkflowLibrary synthesizes `{ default: <statuses|built-in> }` for a
  // legacy config, so the lift is captured here before we overwrite `[id]`.
  const library: Record<string, WorkflowDefinition> = { ...getWorkflowLibrary(config) };
  const label =
    opts.label ??
    library[workflowId]?.label ??
    (workflowId === DEFAULT_WORKFLOW_ID ? 'Default' : toTitleCase(workflowId));
  library[workflowId] = { label, ...bundle };

  const defaultWorkflow = opts.setDefault
    ? workflowId
    : (config.defaultWorkflow ?? DEFAULT_WORKFLOW_ID);

  await writeWorkflowsConfig(library, defaultWorkflow);
  if (wasLegacy) await deleteLegacyStatusesBlock();
}

/**
 * Remove a workflow from the library. Callers MUST run the delete-in-use guard
 * (`scanWorkflowUsage`) first — this helper does no safety checks. The built-in
 * `default` is never removed (it is re-synthesized on read regardless). If the
 * removed workflow was the global `defaultWorkflow`, the default falls back to
 * `default`.
 */
export async function deleteWorkflowFromConfig(workflowId: string): Promise<void> {
  if (workflowId === DEFAULT_WORKFLOW_ID) return;
  const config = await readConfig();
  const library: Record<string, WorkflowDefinition> = { ...getWorkflowLibrary(config) };
  if (!(workflowId in library)) return;
  delete library[workflowId];

  const defaultWorkflow =
    config.defaultWorkflow && config.defaultWorkflow !== workflowId && library[config.defaultWorkflow]
      ? config.defaultWorkflow
      : DEFAULT_WORKFLOW_ID;

  await writeWorkflowsConfig(library, defaultWorkflow);
  if (hasLegacyStatusesOnly(config)) await deleteLegacyStatusesBlock();
}

/** Set the global `defaultWorkflow` scalar, leaving all bundles untouched. */
export async function setDefaultWorkflow(workflowId: string): Promise<void> {
  const config = await readConfig();
  const library: Record<string, WorkflowDefinition> = { ...getWorkflowLibrary(config) };
  await writeWorkflowsConfig(library, workflowId);
  if (hasLegacyStatusesOnly(config)) await deleteLegacyStatusesBlock();
}
