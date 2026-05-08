import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { expandHome, assignmentsDir as assignmentsDirFn } from './paths.js';
import { fileExists } from './fs.js';
import { readConfig } from './config.js';
import { isValidSlug } from './slug.js';
import { resolveAssignmentById, type ResolvedAssignment } from './assignment-resolver.js';
import { extractFrontmatter, getField } from '../dashboard/parser.js';

export interface AssignmentTargetOptions {
  project?: string;
  dir?: string;
  cwd?: string;
}

export class AssignmentTargetError extends Error {}

interface ContextJsonShape {
  projectSlug?: string | null;
  assignmentSlug?: string | null;
  assignmentDir?: string | null;
}

async function readAssignmentFrontmatterId(assignmentDir: string): Promise<string | null> {
  const path = resolve(assignmentDir, 'assignment.md');
  if (!(await fileExists(path))) return null;
  try {
    const content = await readFile(path, 'utf-8');
    const [fm] = extractFrontmatter(content);
    return getField(fm, 'id');
  } catch {
    return null;
  }
}

async function readContextJson(cwd: string): Promise<ContextJsonShape | null> {
  const path = resolve(cwd, '.syntaur', 'context.json');
  if (!(await fileExists(path))) return null;
  try {
    const raw = await readFile(path, 'utf-8');
    return JSON.parse(raw) as ContextJsonShape;
  } catch {
    return null;
  }
}

/**
 * Resolve an assignment target across the three input shapes used by the
 * proof-artifacts feature:
 *
 *   1. `--project <slug> + <assignment-slug>` (positional)
 *   2. bare UUID (positional, resolves standalone or project-nested via frontmatter id)
 *   3. no positional + .syntaur/context.json fallback (must contain
 *      `assignmentDir` OR `projectSlug + assignmentSlug`)
 *
 * `--dir` overrides the projects base dir for cases 1 and 2.
 *
 * Throws AssignmentTargetError on any unresolved input. The returned shape
 * mirrors `ResolvedAssignment` from assignment-resolver.ts.
 */
export async function resolveAssignmentTarget(
  input: string | undefined,
  opts: AssignmentTargetOptions = {},
): Promise<ResolvedAssignment> {
  const config = await readConfig();
  const baseDir = opts.dir ? expandHome(opts.dir) : config.defaultProjectDir;

  // Case 1: --project + positional slug
  if (opts.project) {
    if (!input) {
      throw new AssignmentTargetError(
        '--project requires an assignment slug as a positional argument.',
      );
    }
    if (!isValidSlug(opts.project)) {
      throw new AssignmentTargetError(`Invalid project slug "${opts.project}".`);
    }
    if (!isValidSlug(input)) {
      throw new AssignmentTargetError(`Invalid assignment slug "${input}".`);
    }
    const projectDir = resolve(baseDir, opts.project);
    const projectMdPath = resolve(projectDir, 'project.md');
    if (!(await fileExists(projectDir)) || !(await fileExists(projectMdPath))) {
      throw new AssignmentTargetError(
        `Project "${opts.project}" not found at ${projectDir}.`,
      );
    }
    const assignmentDir = resolve(projectDir, 'assignments', input);
    const assignmentMdPath = resolve(assignmentDir, 'assignment.md');
    if (!(await fileExists(assignmentMdPath))) {
      throw new AssignmentTargetError(
        `Assignment "${input}" not found in project "${opts.project}".`,
      );
    }
    const id = (await readAssignmentFrontmatterId(assignmentDir)) ?? input;
    return {
      assignmentDir,
      projectSlug: opts.project,
      assignmentSlug: input,
      id,
      standalone: false,
      workspaceGroup: null,
    };
  }

  // Case 2: bare UUID/id positional
  if (input) {
    const resolved = await resolveAssignmentById(baseDir, assignmentsDirFn(), input);
    if (!resolved) {
      throw new AssignmentTargetError(
        `Assignment "${input}" not found. Provide --project <slug> + <slug> or a valid standalone UUID.`,
      );
    }
    return resolved;
  }

  // Case 3: no positional → .syntaur/context.json fallback
  const cwd = opts.cwd ?? process.cwd();
  const ctx = await readContextJson(cwd);
  if (!ctx) {
    throw new AssignmentTargetError(
      'No assignment specified. Provide an argument, --project + slug, or run from a directory with .syntaur/context.json.',
    );
  }

  if (ctx.assignmentDir) {
    const dir = expandHome(ctx.assignmentDir);
    const assignmentMdPath = resolve(dir, 'assignment.md');
    if (!(await fileExists(assignmentMdPath))) {
      throw new AssignmentTargetError(
        `.syntaur/context.json points to a missing assignment dir: ${dir}.`,
      );
    }
    const id = await readAssignmentFrontmatterId(dir);
    if (!id || id.trim() === '') {
      throw new AssignmentTargetError(
        `.syntaur/context.json points to an assignment with no frontmatter \`id\`: ${dir}.`,
      );
    }
    const assignmentSlug = ctx.assignmentSlug ?? dir.split('/').pop() ?? '';
    const projectSlug = ctx.projectSlug ?? null;
    return {
      assignmentDir: dir,
      projectSlug,
      assignmentSlug,
      id,
      standalone: projectSlug === null,
      workspaceGroup: null,
    };
  }

  if (ctx.projectSlug && ctx.assignmentSlug) {
    if (!isValidSlug(ctx.projectSlug) || !isValidSlug(ctx.assignmentSlug)) {
      throw new AssignmentTargetError(
        `.syntaur/context.json contains invalid slugs: project="${ctx.projectSlug}" assignment="${ctx.assignmentSlug}".`,
      );
    }
    const assignmentDir = resolve(baseDir, ctx.projectSlug, 'assignments', ctx.assignmentSlug);
    const assignmentMdPath = resolve(assignmentDir, 'assignment.md');
    if (!(await fileExists(assignmentMdPath))) {
      throw new AssignmentTargetError(
        `.syntaur/context.json points to a missing assignment: ${assignmentDir}.`,
      );
    }
    const id = (await readAssignmentFrontmatterId(assignmentDir)) ?? ctx.assignmentSlug;
    return {
      assignmentDir,
      projectSlug: ctx.projectSlug,
      assignmentSlug: ctx.assignmentSlug,
      id,
      standalone: false,
      workspaceGroup: null,
    };
  }

  throw new AssignmentTargetError(
    '.syntaur/context.json exists but contains neither assignmentDir nor projectSlug+assignmentSlug.',
  );
}
