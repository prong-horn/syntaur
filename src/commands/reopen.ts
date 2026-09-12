import { resolve } from 'node:path';
import { runTransition, reportResult, type LifecycleOptions } from './_lifecycle-helper.js';
import { readConfig } from '../utils/config.js';
import { expandHome, ticketsDir as ticketsDirFn } from '../utils/paths.js';
import { resolveTicketById } from '../utils/ticket-resolver.js';
import { recomputeAndWrite, recomputeDependents, resolveRecomputeContext } from '../lifecycle/recompute.js';
import { isEngineActiveForAssignment } from '../lifecycle/engine-transition.js';

export interface ReopenOptions extends LifecycleOptions {}

/** Reopen exits terminal via the gated transition, then immediately
 * re-derives so the ticket lands where its facts actually are (not the
 * imperative in_progress target). */
export async function reopenCommand(
  ticket: string,
  options: ReopenOptions,
): Promise<void> {
  const result = await runTransition(ticket, 'reopen', options);
  reportResult(result);
  if (!result.success) return;

  const config = await readConfig();
  const baseDir = options.dir ? expandHome(options.dir) : config.defaultProjectDir;
  const { context, workflowResolver } = await resolveRecomputeContext();
  let ticketPath: string;
  let projectDir: string | null;
  // The dir slug recomputeDependents matches `dependsOn` against — NOT the raw
  // arg, which is a UUID when reopened by id (that would silently match nothing).
  let changedSlug: string;
  if (options.project) {
    projectDir = resolve(baseDir, options.project);
    ticketPath = resolve(projectDir, 'tickets', ticket, 'ticket.md');
    changedSlug = ticket;
  } else {
    const resolved = await resolveTicketById(baseDir, ticketsDirFn(), ticket);
    if (!resolved) return;
    ticketPath = resolve(resolved.ticketDir, 'ticket.md');
    projectDir = resolved.standalone ? null : resolve(resolved.ticketDir, '..', '..');
    changedSlug = resolved.ticketSlug;
  }
  // The post-reopen re-derive lands the LADDER ticket where its facts are (not
  // the imperative in_progress target). On the ENGINE path the reopen already
  // re-placed the ticket deliberately WITHOUT re-cascading and ran its terminal
  // side effects; a second default `gate` recompute here would auto-advance it
  // forward and undo the reopen (codex re-review). Skip it when engine-active.
  if (!(await isEngineActiveForAssignment(ticketPath, projectDir))) {
    const derived = await recomputeAndWrite(ticketPath, {
      cause: 'reopen',
      by: 'system',
      projectDir,
      context,
      workflowResolver,
    });
    if (derived.changed) {
      console.log(`Re-derived after reopen — status: ${derived.status}`);
    }
  }

  // Leaving terminal flips dependents' depsSatisfied back to false.
  if (projectDir) {
    const results = await recomputeDependents(projectDir, changedSlug, {
      cause: 'dep-reopened',
      by: 'system',
      context,
      workflowResolver,
    });
    const changed = results.filter((r) => r.changed).length;
    if (changed > 0) console.log(`Re-derived ${changed} dependent assignment(s).`);
  }
}
