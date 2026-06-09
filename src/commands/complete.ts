import { resolve } from 'node:path';
import { runTransition, reportResult, type LifecycleOptions } from './_lifecycle-helper.js';
import { readConfig } from '../utils/config.js';
import { expandHome } from '../utils/paths.js';
import { recomputeDependents, resolveDeriveContext } from '../lifecycle/recompute.js';

export interface CompleteOptions extends LifecycleOptions {}

/** Terminal stays gated: complete runs the existing transition (mutual
 * exclusion + linked-todo side effects), then reverse-dependency recompute —
 * dependents' depsSatisfied fact just changed. */
export async function completeCommand(
  assignment: string,
  options: CompleteOptions,
): Promise<void> {
  const result = await runTransition(assignment, 'complete', options);
  reportResult(result);
  if (result.success && options.project) {
    const config = await readConfig();
    const baseDir = options.dir ? expandHome(options.dir) : config.defaultProjectDir;
    const projectDir = resolve(baseDir, options.project);
    const context = await resolveDeriveContext();
    const results = await recomputeDependents(projectDir, assignment, {
      cause: 'dep-terminal',
      by: 'system',
      context,
    });
    const changed = results.filter((r) => r.changed).length;
    if (changed > 0) console.log(`Re-derived ${changed} dependent assignment(s).`);
  }
}
