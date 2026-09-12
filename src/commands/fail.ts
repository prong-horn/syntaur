import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { runTransition, reportResult, type LifecycleOptions } from './_lifecycle-helper.js';
import { readConfig } from '../utils/config.js';
import { expandHome, ticketsDir as ticketsDirFn } from '../utils/paths.js';
import { resolveTicketById, resolveTicketMdPathInProject } from '../utils/ticket-resolver.js';
import { parseTicketFrontmatter } from '../lifecycle/frontmatter.js';
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
  let changedTicketId: string;
  if (options.project) {
    projectDir = resolve(baseDir, options.project);
    const ticketPath = await resolveTicketMdPathInProject(projectDir, ticket);
    if (!ticketPath) return;
    changedTicketId = parseTicketFrontmatter(await readFile(ticketPath, 'utf-8')).id;
  } else {
    const resolved = await resolveTicketById(baseDir, ticketsDirFn(), ticket);
    if (!resolved) return;
    projectDir = resolved.standalone ? null : resolve(resolved.ticketDir, '..', '..');
    changedTicketId = resolved.id;
  }
  if (projectDir) {
    const { context, workflowResolver } = await resolveRecomputeContext();
    const results = await recomputeDependents(projectDir, changedTicketId, {
      cause: 'dep-terminal',
      by: 'system',
      context,
      workflowResolver,
    });
    const changed = results.filter((r) => r.changed).length;
    if (changed > 0) console.log(`Re-derived ${changed} dependent ticket(s).`);
  }
}
