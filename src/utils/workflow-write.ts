/**
 * Node-only write helpers for the multi-workflow library. These sit above
 * `writeWorkflowsConfig` (config.ts) and `getWorkflowLibrary` (workflow-resolve.ts)
 * and are the single lift point where writes first introduce the `workflows:`
 * block: on the first per-workflow write to a legacy single-config, the existing
 * top-level `statuses:` block is captured as `workflows.default` and then
 * deleted (Decision D4). Kept in their own module to avoid a config ⇄
 * workflow-resolve import cycle (config.ts must not import workflow-resolve).
 */

import { unlink } from 'node:fs/promises';
import {
  readConfig,
  writeStatusConfig,
  writeWorkflowsConfig,
  deleteLegacyStatusesBlock,
  writeDefaultWorkflowScalar,
  LegacyWorkflowWriteLockedError,
  type StatusConfig,
  type WorkflowDefinition,
} from './config.js';
import { isStagesMigrated } from './stages-marker.js';
import { getWorkflowLibrary, DEFAULT_WORKFLOW_ID } from './workflow-resolve.js';
import { toTitleCase } from './status-defaults.js';
import { writeFileForce } from './fs.js';
import { serializeWorkflowFile, workflowFilePath, isValidWorkflowId } from './workflow-file.js';
import { invalidateWorkflowLibraryCache } from './workflow-library.js';
import type { StageWorkflow } from './stage-model.js';

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
  // WS-3 T9b: fail fast post-migration — the inner writeStatusConfig/
  // writeWorkflowsConfig writers carry the same guard (fewest-misses point),
  // but refusing here surfaces the lockout before any config read.
  if (await isStagesMigrated()) throw new LegacyWorkflowWriteLockedError();
  const config = await readConfig();

  // Editing the DEFAULT workflow of a still-legacy config keeps the legacy
  // top-level `statuses:` format — a single-workflow config never grows a
  // `workflows:` block just from status-settings edits. The block (and the D4
  // lift+delete) is introduced only when a real, non-default workflow is
  // created below, or when one already exists.
  if (
    !hasWorkflowsBlock(config) &&
    workflowId === DEFAULT_WORKFLOW_ID &&
    !opts.setDefault &&
    opts.label === undefined // a custom label can only live in the workflows: block
  ) {
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

// --- Per-file stage-workflow writers (Phase 1 stage engine, WS-0) -----------
//
// These are the NEW per-file substrate for the stage model, kept SEPARATE from
// the legacy `StatusConfig`-based writers above (which stay wired to the live
// dashboard editor / `syntaur status` / `syntaur workflow` and remain the source
// of truth until WS-3's migration). They target `~/.syntaur/workflows/<id>.md`
// yaml and invalidate the per-file loader cache. Nothing calls them on a live
// path yet — WS-3's migration writes the first per-file workflow through here
// (decision D1). Storing a workflow this way while a `config.md` block still
// exists would trip the loader's single-source hard-error, which is by design:
// the relocation must delete the block in the same commit.

/**
 * Write one workflow to `~/.syntaur/workflows/<id>.md` (yaml), creating the dir
 * if needed. Labels live inside each file now, so the whole {@link StageWorkflow}
 * (including `label`) round-trips. Invalidates the loader cache.
 */
export async function writeWorkflowFile(workflow: StageWorkflow): Promise<void> {
  if (!workflow.id) throw new Error('writeWorkflowFile: workflow.id is required');
  // writeFileForce mkdir -p's the parent (`~/.syntaur/workflows/`) before writing.
  await writeFileForce(workflowFilePath(workflow.id), serializeWorkflowFile(workflow));
  invalidateWorkflowLibraryCache();
}

/**
 * Delete `~/.syntaur/workflows/<id>.md`. No-op if the file is absent. Invalidates
 * the loader cache. (The built-in `default` synthesis fallback lives in the pure
 * resolver, so removing a file never leaves callers without a usable library.)
 */
export async function deleteWorkflowFile(id: string): Promise<void> {
  try {
    await unlink(workflowFilePath(id));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  invalidateWorkflowLibraryCache();
}

/**
 * Set the global default workflow as a scalar `defaultWorkflow:` pointer in
 * config.md frontmatter — a pointer, not a workflow body, so it does NOT
 * reintroduce a `workflows:` block and the per-file loader's single-source
 * invariant holds. The per-file counterpart of {@link setDefaultWorkflow}.
 */
export async function setDefaultWorkflowPointer(id: string): Promise<void> {
  // Guard the scalar boundary: a newline/`:` in the id would inject a top-level
  // frontmatter block (e.g. `workflows:`), breaking the single-source invariant.
  if (!isValidWorkflowId(id)) {
    throw new Error(`invalid workflow id "${id}" (must match /^[a-z0-9][a-z0-9_-]*$/, ≤64 chars)`);
  }
  await writeDefaultWorkflowScalar(id);
}
