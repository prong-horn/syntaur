import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { expandHome, ticketsDir as ticketsDirFn } from '../utils/paths.js';
import { fileExists } from '../utils/fs.js';
import { readConfig, type SyntaurConfig } from '../utils/config.js';
import { isValidSlug } from '../utils/slug.js';
import {
  executeTransition,
  executeTransitionByDir,
  executeAssign,
  executeAssignByDir,
  executeUnassign,
  executeUnassignByDir,
  parseTicketFrontmatter,
  unambiguousCommandTarget,
  type TransitionCommand,
  type TransitionOptions,
  type TransitionResult,
} from '../lifecycle/index.js';
import { resolveTicketWorkflowContext } from '../lifecycle/workflow-context.js';
import { runEngineTransition } from '../lifecycle/engine-transition.js';
import { resolveTicketById, resolveTicketMdPathInProject } from '../utils/ticket-resolver.js';

type WorkflowTransitionOptions = Pick<
  TransitionOptions,
  'transitionTable' | 'commandTargets' | 'terminalStatuses'
>;

/**
 * Resolve the ticket's OWN workflow and derive the transition context to
 * hand `executeTransition*` (Fix 1): its `from:command` table, terminal set,
 * and a guard-free single-command target. Without this the CLI terminal verbs
 * (`complete`/`fail`/`reopen`) ignore custom workflows entirely.
 *
 * Empty-transitions guard: a workflow with no `transitions:` block (e.g. the
 * live `workflows.default`) must NOT get an empty custom table — that would
 * disable the built-in fallback in `executeTransition` and break the verbs
 * outright. Returning `{}` keeps default/legacy behavior byte-identical; a
 * renamed terminal status only takes effect once its workflow defines the
 * transitions needed to reach it.
 */
async function resolveWorkflowTransitionOptions(
  ticketPath: string,
  projectDir: string | null,
  command: string,
  config: SyntaurConfig,
): Promise<WorkflowTransitionOptions> {
  let content: string;
  try {
    content = await readFile(ticketPath, 'utf-8');
  } catch (err) {
    // Missing file → let executeTransition* surface its canonical
    // "Ticket file not found" error; any other read error propagates.
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return {};
    throw err;
  }
  const fm = parseTicketFrontmatter(content);
  const ctx = await resolveTicketWorkflowContext({ ticket: fm, projectDir, config });
  if (ctx.bundle.transitions.length === 0) return {};
  const target = unambiguousCommandTarget(ctx.bundle.transitions, command);
  return {
    transitionTable: ctx.transitionTable,
    terminalStatuses: ctx.terminalStatuses,
    ...(target !== undefined ? { commandTargets: new Map([[command, target]]) } : {}),
  };
}

export interface LifecycleOptions {
  project?: string;
  dir?: string;
  reason?: string;
  agent?: string;
}

export async function runTransition(
  ticket: string,
  command: Exclude<TransitionCommand, 'assign'>,
  options: LifecycleOptions = {},
): Promise<TransitionResult> {
  const config = await readConfig();
  const baseDir = options.dir ? expandHome(options.dir) : config.defaultProjectDir;

  if (options.project) {
    if (!isValidSlug(options.project)) {
      throw new Error(`Invalid project slug "${options.project}".`);
    }
    if (!isValidSlug(ticket)) {
      throw new Error(`Invalid ticket slug "${ticket}".`);
    }
    const projectDir = resolve(baseDir, options.project);
    const projectMdPath = resolve(projectDir, 'project.md');
    if (!(await fileExists(projectDir)) || !(await fileExists(projectMdPath))) {
      throw new Error(`Project "${options.project}" not found at ${projectDir}.`);
    }
    const ticketPath = await resolveTicketMdPathInProject(projectDir, ticket);
    if (!ticketPath) {
      throw new Error(`Ticket file not found for "${ticket}" in project "${options.project}".`);
    }
    // WS-2 (Decision 1): on the MIGRATED path a terminal command is realized as
    // an ENGINE move through the locked recompute. `null` ⇒ not migrated / no
    // per-file workflow / not an engine command → fall through to the ladder.
    const engineResult = await runEngineTransition({
      ticketPath,
      projectDir,
      command,
      by: options.agent ?? null,
      reason: options.reason,
    });
    if (engineResult) return engineResult;
    const workflowOpts = await resolveWorkflowTransitionOptions(
      ticketPath,
      projectDir,
      command,
      config,
    );
    return executeTransition(projectDir, ticket, command, {
      reason: options.reason,
      agent: options.agent,
      ...workflowOpts,
    });
  }

  const resolved = await resolveTicketById(baseDir, ticketsDirFn(), ticket);
  if (!resolved) {
    throw new Error(
      `Ticket "${ticket}" not found. Provide --project <slug> or a valid standalone UUID.`,
    );
  }
  const projectDir = resolved.standalone ? null : resolve(resolved.ticketDir, '..', '..');
  const ticketPath = resolve(resolved.ticketDir, 'ticket.md');
  const engineResult = await runEngineTransition({
    ticketPath,
    projectDir,
    command,
    by: options.agent ?? null,
    reason: options.reason,
  });
  if (engineResult) return engineResult;
  const workflowOpts = await resolveWorkflowTransitionOptions(
    ticketPath,
    projectDir,
    command,
    config,
  );
  return executeTransitionByDir(resolved.ticketDir, command, {
    reason: options.reason,
    agent: options.agent,
    standalone: resolved.standalone,
    ...workflowOpts,
  });
}

export async function runAssign(
  ticket: string,
  agent: string,
  options: LifecycleOptions = {},
): Promise<TransitionResult> {
  const config = await readConfig();
  const baseDir = options.dir ? expandHome(options.dir) : config.defaultProjectDir;

  if (options.project) {
    if (!isValidSlug(options.project)) {
      throw new Error(`Invalid project slug "${options.project}".`);
    }
    if (!isValidSlug(ticket)) {
      throw new Error(`Invalid ticket slug "${ticket}".`);
    }
    const projectDir = resolve(baseDir, options.project);
    const projectMdPath = resolve(projectDir, 'project.md');
    if (!(await fileExists(projectDir)) || !(await fileExists(projectMdPath))) {
      throw new Error(`Project "${options.project}" not found at ${projectDir}.`);
    }
    return executeAssign(projectDir, ticket, agent);
  }

  const resolved = await resolveTicketById(baseDir, ticketsDirFn(), ticket);
  if (!resolved) {
    throw new Error(
      `Ticket "${ticket}" not found. Provide --project <slug> or a valid standalone UUID.`,
    );
  }
  return executeAssignByDir(resolved.ticketDir, agent);
}

export async function runUnassign(
  ticket: string,
  options: LifecycleOptions = {},
): Promise<TransitionResult> {
  const config = await readConfig();
  const baseDir = options.dir ? expandHome(options.dir) : config.defaultProjectDir;

  if (options.project) {
    if (!isValidSlug(options.project)) {
      throw new Error(`Invalid project slug "${options.project}".`);
    }
    if (!isValidSlug(ticket)) {
      throw new Error(`Invalid ticket slug "${ticket}".`);
    }
    const projectDir = resolve(baseDir, options.project);
    const projectMdPath = resolve(projectDir, 'project.md');
    if (!(await fileExists(projectDir)) || !(await fileExists(projectMdPath))) {
      throw new Error(`Project "${options.project}" not found at ${projectDir}.`);
    }
    return executeUnassign(projectDir, ticket);
  }

  const resolved = await resolveTicketById(baseDir, ticketsDirFn(), ticket);
  if (!resolved) {
    throw new Error(
      `Ticket "${ticket}" not found. Provide --project <slug> or a valid standalone UUID.`,
    );
  }
  return executeUnassignByDir(resolved.ticketDir);
}

export function reportResult(result: TransitionResult): void {
  if (!result.success) {
    throw new Error(result.message);
  }
  console.log(result.message);
  for (const warning of result.warnings ?? []) {
    console.warn(`Warning: ${warning}`);
  }
}
