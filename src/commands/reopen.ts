import { resolve } from 'node:path';
import { runTransition, reportResult, type LifecycleOptions } from './_lifecycle-helper.js';
import { readConfig } from '../utils/config.js';
import { expandHome, assignmentsDir as assignmentsDirFn } from '../utils/paths.js';
import { resolveAssignmentById } from '../utils/assignment-resolver.js';
import { recomputeAndWrite, recomputeDependents, resolveDeriveContext } from '../lifecycle/recompute.js';

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
  // The dir slug recomputeDependents matches `dependsOn` against — NOT the raw
  // arg, which is a UUID when reopened by id (that would silently match nothing).
  let changedSlug: string;
  if (options.project) {
    projectDir = resolve(baseDir, options.project);
    assignmentPath = resolve(projectDir, 'assignments', assignment, 'assignment.md');
    changedSlug = assignment;
  } else {
    const resolved = await resolveAssignmentById(baseDir, assignmentsDirFn(), assignment);
    if (!resolved) return;
    assignmentPath = resolve(resolved.assignmentDir, 'assignment.md');
    projectDir = resolved.standalone ? null : resolve(resolved.assignmentDir, '..', '..');
    changedSlug = resolved.assignmentSlug;
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

  // Leaving terminal flips dependents' depsSatisfied back to false.
  if (projectDir) {
    const results = await recomputeDependents(projectDir, changedSlug, {
      cause: 'dep-reopened',
      by: 'system',
      context,
    });
    const changed = results.filter((r) => r.changed).length;
    if (changed > 0) console.log(`Re-derived ${changed} dependent assignment(s).`);
  }
}
