import { resolve } from 'node:path';
import { runTransition, reportResult, type LifecycleOptions } from './_lifecycle-helper.js';
import { readConfig } from '../utils/config.js';
import { expandHome, ticketsDir as ticketsDirFn } from '../utils/paths.js';
import { resolveTicketById } from '../utils/ticket-resolver.js';
import { recomputeDependents, resolveRecomputeContext } from '../lifecycle/recompute.js';

export interface FailOptions extends LifecycleOptions {
  reason?: string;
}

/** Terminal stays gated; like complete, failing changes dependents'
 * depsSatisfied fact → reverse-dependency recompute. Resolves project dir + slug
 * even when addressed by UUID without `--project`, and recomputes by the
 * resolved SLUG. */
export async function failCommand(
  ticket: string,
  options: FailOptions,
): Promise<void> {
  const result = await runTransition(ticket, 'fail', options);
  reportResult(result);
  if (!result.success) return;

  const config = await readConfig();
  const baseDir = options.dir ? expandHome(options.dir) : config.defaultProjectDir;
  let projectDir: string | null;
  let changedSlug: string;
  if (options.project) {
    projectDir = resolve(baseDir, options.project);
    changedSlug = ticket;
  } else {
    const resolved = await resolveTicketById(baseDir, ticketsDirFn(), ticket);
    if (!resolved) return;
    projectDir = resolved.standalone ? null : resolve(resolved.ticketDir, '..', '..');
    changedSlug = resolved.ticketSlug;
  }
  if (projectDir) {
    const { context, workflowResolver } = await resolveRecomputeContext();
    const results = await recomputeDependents(projectDir, changedSlug, {
      cause: 'dep-terminal',
      by: 'system',
      context,
      workflowResolver,
    });
    const changed = results.filter((r) => r.changed).length;
    if (changed > 0) console.log(`Re-derived ${changed} dependent assignment(s).`);
  }
}
