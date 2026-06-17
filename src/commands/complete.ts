import { resolve } from 'node:path';
import { runTransition, reportResult, type LifecycleOptions } from './_lifecycle-helper.js';
import { readConfig } from '../utils/config.js';
import { expandHome, assignmentsDir as assignmentsDirFn } from '../utils/paths.js';
import { resolveAssignmentById } from '../utils/assignment-resolver.js';
import { recomputeDependents, resolveDeriveContext } from '../lifecycle/recompute.js';

export interface CompleteOptions extends LifecycleOptions {}

/** Terminal stays gated: complete runs the existing transition (mutual
 * exclusion + linked-todo side effects), then reverse-dependency recompute —
 * dependents' depsSatisfied fact just changed. Resolves the project dir + slug
 * even when the assignment was addressed by UUID without `--project` (mirrors
 * reopen), and recomputes by the resolved SLUG (recomputeDependents matches
 * `dependsOn` against slugs, not UUIDs). */
export async function completeCommand(
  assignment: string,
  options: CompleteOptions,
): Promise<void> {
  const result = await runTransition(assignment, 'complete', options);
  reportResult(result);
  if (!result.success) return;

  const config = await readConfig();
  const baseDir = options.dir ? expandHome(options.dir) : config.defaultProjectDir;
  let projectDir: string | null;
  let changedSlug: string;
  if (options.project) {
    projectDir = resolve(baseDir, options.project);
    changedSlug = assignment;
  } else {
    const resolved = await resolveAssignmentById(baseDir, assignmentsDirFn(), assignment);
    if (!resolved) return;
    projectDir = resolved.standalone ? null : resolve(resolved.assignmentDir, '..', '..');
    changedSlug = resolved.assignmentSlug;
  }
  if (projectDir) {
    const context = await resolveDeriveContext();
    const results = await recomputeDependents(projectDir, changedSlug, {
      cause: 'dep-terminal',
      by: 'system',
      context,
    });
    const changed = results.filter((r) => r.changed).length;
    if (changed > 0) console.log(`Re-derived ${changed} dependent assignment(s).`);
  }
}
