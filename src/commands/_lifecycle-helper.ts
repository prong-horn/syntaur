import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { expandHome, assignmentsDir as assignmentsDirFn, todosDir as todosDirFn } from '../utils/paths.js';
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
  parseAssignmentFrontmatter,
  unambiguousCommandTarget,
  type TransitionCommand,
  type TransitionOptions,
  type TransitionResult,
} from '../lifecycle/index.js';
import { resolveAssignmentWorkflowContext } from '../lifecycle/workflow-context.js';
import { resolveAssignmentById } from '../utils/assignment-resolver.js';

type WorkflowTransitionOptions = Pick<
  TransitionOptions,
  'transitionTable' | 'commandTargets' | 'terminalStatuses'
>;

/**
 * Resolve the assignment's OWN workflow and derive the transition context to
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
  assignmentPath: string,
  projectDir: string | null,
  command: string,
  config: SyntaurConfig,
): Promise<WorkflowTransitionOptions> {
  let content: string;
  try {
    content = await readFile(assignmentPath, 'utf-8');
  } catch (err) {
    // Missing file → let executeTransition* surface its canonical
    // "Assignment file not found" error; any other read error propagates.
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return {};
    throw err;
  }
  const fm = parseAssignmentFrontmatter(content);
  const ctx = await resolveAssignmentWorkflowContext({ assignment: fm, projectDir, config });
  if (ctx.bundle.transitions.length === 0) return {};
  const target = unambiguousCommandTarget(ctx.bundle.transitions, command);
  return {
    transitionTable: ctx.transitionTable,
    terminalStatuses: ctx.terminalStatuses,
    ...(target !== undefined ? { commandTargets: new Map([[command, target]]) } : {}),
  };
}

function resolveLinkedTodosLookup(projectsDir: string): { todosDir: string; projectsDir: string } {
  return { todosDir: todosDirFn(), projectsDir };
}

export interface LifecycleOptions {
  project?: string;
  dir?: string;
  reason?: string;
  agent?: string;
}

export async function runTransition(
  assignment: string,
  command: Exclude<TransitionCommand, 'assign'>,
  options: LifecycleOptions = {},
): Promise<TransitionResult> {
  const config = await readConfig();
  const baseDir = options.dir ? expandHome(options.dir) : config.defaultProjectDir;

  if (options.project) {
    if (!isValidSlug(options.project)) {
      throw new Error(`Invalid project slug "${options.project}".`);
    }
    if (!isValidSlug(assignment)) {
      throw new Error(`Invalid assignment slug "${assignment}".`);
    }
    const projectDir = resolve(baseDir, options.project);
    const projectMdPath = resolve(projectDir, 'project.md');
    if (!(await fileExists(projectDir)) || !(await fileExists(projectMdPath))) {
      throw new Error(`Project "${options.project}" not found at ${projectDir}.`);
    }
    const workflowOpts = await resolveWorkflowTransitionOptions(
      resolve(projectDir, 'assignments', assignment, 'assignment.md'),
      projectDir,
      command,
      config,
    );
    return executeTransition(projectDir, assignment, command, {
      reason: options.reason,
      agent: options.agent,
      linkedTodosLookup: resolveLinkedTodosLookup(baseDir),
      ...workflowOpts,
    });
  }

  const resolved = await resolveAssignmentById(baseDir, assignmentsDirFn(), assignment);
  if (!resolved) {
    throw new Error(
      `Assignment "${assignment}" not found. Provide --project <slug> or a valid standalone UUID.`,
    );
  }
  const projectDir = resolved.standalone ? null : resolve(resolved.assignmentDir, '..', '..');
  const workflowOpts = await resolveWorkflowTransitionOptions(
    resolve(resolved.assignmentDir, 'assignment.md'),
    projectDir,
    command,
    config,
  );
  return executeTransitionByDir(resolved.assignmentDir, command, {
    reason: options.reason,
    agent: options.agent,
    standalone: resolved.standalone,
    linkedTodosLookup: resolveLinkedTodosLookup(baseDir),
    ...workflowOpts,
  });
}

export async function runAssign(
  assignment: string,
  agent: string,
  options: LifecycleOptions = {},
): Promise<TransitionResult> {
  const config = await readConfig();
  const baseDir = options.dir ? expandHome(options.dir) : config.defaultProjectDir;

  if (options.project) {
    if (!isValidSlug(options.project)) {
      throw new Error(`Invalid project slug "${options.project}".`);
    }
    if (!isValidSlug(assignment)) {
      throw new Error(`Invalid assignment slug "${assignment}".`);
    }
    const projectDir = resolve(baseDir, options.project);
    const projectMdPath = resolve(projectDir, 'project.md');
    if (!(await fileExists(projectDir)) || !(await fileExists(projectMdPath))) {
      throw new Error(`Project "${options.project}" not found at ${projectDir}.`);
    }
    return executeAssign(projectDir, assignment, agent);
  }

  const resolved = await resolveAssignmentById(baseDir, assignmentsDirFn(), assignment);
  if (!resolved) {
    throw new Error(
      `Assignment "${assignment}" not found. Provide --project <slug> or a valid standalone UUID.`,
    );
  }
  return executeAssignByDir(resolved.assignmentDir, agent);
}

export async function runUnassign(
  assignment: string,
  options: LifecycleOptions = {},
): Promise<TransitionResult> {
  const config = await readConfig();
  const baseDir = options.dir ? expandHome(options.dir) : config.defaultProjectDir;

  if (options.project) {
    if (!isValidSlug(options.project)) {
      throw new Error(`Invalid project slug "${options.project}".`);
    }
    if (!isValidSlug(assignment)) {
      throw new Error(`Invalid assignment slug "${assignment}".`);
    }
    const projectDir = resolve(baseDir, options.project);
    const projectMdPath = resolve(projectDir, 'project.md');
    if (!(await fileExists(projectDir)) || !(await fileExists(projectMdPath))) {
      throw new Error(`Project "${options.project}" not found at ${projectDir}.`);
    }
    return executeUnassign(projectDir, assignment);
  }

  const resolved = await resolveAssignmentById(baseDir, assignmentsDirFn(), assignment);
  if (!resolved) {
    throw new Error(
      `Assignment "${assignment}" not found. Provide --project <slug> or a valid standalone UUID.`,
    );
  }
  return executeUnassignByDir(resolved.assignmentDir);
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
