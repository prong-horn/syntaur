import { resolve } from 'node:path';
import { expandHome, assignmentsDir as assignmentsDirFn } from '../utils/paths.js';
import { fileExists } from '../utils/fs.js';
import { readConfig } from '../utils/config.js';
import { isValidSlug } from '../utils/slug.js';
import {
  executeTransition,
  executeTransitionByDir,
  executeAssign,
  executeAssignByDir,
  type TransitionCommand,
  type TransitionResult,
} from '../lifecycle/index.js';
import { resolveAssignmentById } from '../utils/assignment-resolver.js';

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
    return executeTransition(projectDir, assignment, command, {
      reason: options.reason,
      agent: options.agent,
    });
  }

  const resolved = await resolveAssignmentById(baseDir, assignmentsDirFn(), assignment);
  if (!resolved) {
    throw new Error(
      `Assignment "${assignment}" not found. Provide --project <slug> or a valid standalone UUID.`,
    );
  }
  return executeTransitionByDir(resolved.assignmentDir, command, {
    reason: options.reason,
    agent: options.agent,
    standalone: resolved.standalone,
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

export function reportResult(result: TransitionResult): void {
  if (!result.success) {
    throw new Error(result.message);
  }
  console.log(result.message);
  for (const warning of result.warnings ?? []) {
    console.warn(`Warning: ${warning}`);
  }
}
