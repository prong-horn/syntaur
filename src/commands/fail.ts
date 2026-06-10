import { resolve } from 'node:path';
import { runTransition, reportResult, type LifecycleOptions } from './_lifecycle-helper.js';
import { readConfig } from '../utils/config.js';
import { expandHome } from '../utils/paths.js';
import { recomputeDependents, resolveDeriveContext } from '../lifecycle/recompute.js';

export interface FailOptions extends LifecycleOptions {
  reason?: string;
}

/** Terminal stays gated; like complete, failing changes dependents'
 * depsSatisfied fact → reverse-dependency recompute. */
export async function failCommand(
  assignment: string,
  options: FailOptions,
): Promise<void> {
  const result = await runTransition(assignment, 'fail', options);
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
