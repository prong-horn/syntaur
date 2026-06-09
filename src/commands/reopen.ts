import { resolve } from 'node:path';
import { runTransition, reportResult, type LifecycleOptions } from './_lifecycle-helper.js';
import { readConfig } from '../utils/config.js';
import { expandHome, assignmentsDir as assignmentsDirFn } from '../utils/paths.js';
import { resolveAssignmentById } from '../utils/assignment-resolver.js';
import { recomputeAndWrite, resolveDeriveContext } from '../lifecycle/recompute.js';

export interface ReopenOptions extends LifecycleOptions {}

/** Reopen exits terminal via the gated transition, then immediately
 * re-derives so the assignment lands where its facts actually are (not the
 * imperative in_progress target). */
export async function reopenCommand(
  assignment: string,
  options: ReopenOptions,
): Promise<void> {
  const result = await runTransition(assignment, 'reopen', options);
  reportResult(result);
  if (!result.success) return;

  const config = await readConfig();
  const baseDir = options.dir ? expandHome(options.dir) : config.defaultProjectDir;
  const context = await resolveDeriveContext();
  let assignmentPath: string;
  let projectDir: string | null;
  if (options.project) {
    projectDir = resolve(baseDir, options.project);
    assignmentPath = resolve(projectDir, 'assignments', assignment, 'assignment.md');
  } else {
    const resolved = await resolveAssignmentById(baseDir, assignmentsDirFn(), assignment);
    if (!resolved) return;
    assignmentPath = resolve(resolved.assignmentDir, 'assignment.md');
    projectDir = resolved.standalone ? null : resolve(resolved.assignmentDir, '..', '..');
  }
  const derived = await recomputeAndWrite(assignmentPath, {
    cause: 'reopen',
    by: 'system',
    projectDir,
    context,
  });
  if (derived.changed) {
    console.log(`Re-derived after reopen — status: ${derived.status}`);
  }
}
