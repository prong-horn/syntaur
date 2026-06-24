import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { expandHome, assignmentsDir as assignmentsDirFn } from './paths.js';
import { fileExists } from './fs.js';
import { readConfig } from './config.js';
import { isValidSlug } from './slug.js';
import { resolveAssignmentById, type ResolvedAssignment } from './assignment-resolver.js';
import { extractFrontmatter, getField } from '../dashboard/parser.js';
import type { BundleScope } from '../todos/types.js';
import type { EngagementBinding } from './engagement-binding.js';

export interface AssignmentTargetOptions {
  project?: string;
  dir?: string;
  cwd?: string;
  /**
   * Resolve the active (assignment, stage) from the session's OPEN engagement
   * (Case 3). Injected by callers — the real implementation is
   * `resolveEngagementBinding(cwd)` from engagement-binding.ts; tests pass a
   * stub. When unset or it resolves null, Case 3 throws the no-target selector
   * error. This replaces the demoted `context.json` assignment scalar.
   */
  resolveEngagement?: () => Promise<EngagementBinding | null>;
}

export class AssignmentTargetError extends Error {}

/**
 * `.syntaur/context.json` is a WORKSPACE MARKER, not the active-assignment
 * source. The authoritative active (assignment, stage) lives on the session's
 * open engagement (see resolveAssignmentTarget Case 3); the legacy
 * `projectSlug`/`assignmentSlug`/`assignmentDir` scalars were removed here to
 * close the multi-assignment-in-one-worktree clobber.
 */
export interface ContextJsonShape {
  // Session metadata (populated by Claude Code's SessionStart hook). These are
  // a legacy, co-tenant-clobberable HINT — never trust the sessionId value as
  // identity (resolve that from the process via resolveOwnSessionId). Their
  // PRESENCE vs absence is still a stable signal for classification.
  sessionId?: string | null;
  transcriptPath?: string | null;
  // Bundle-scoped context (set by bundle worktree / grab-bundle). A bundle
  // worktree is NOT an assignment target — see classifyContext().
  bundleId?: string | null;
  bundleSlug?: string | null;
  bundleScope?: BundleScope | null;
  bundleScopeId?: string | null;
  todoIds?: string[] | null;
  planDir?: string | null;
  // Workspace markers.
  branch?: string | null;
  worktreePath?: string | null;
  repository?: string | null;
  boundAt?: string | null;
}

export type ContextKind = 'bundle' | 'standalone' | 'empty';

export function classifyContext(ctx: ContextJsonShape | null): ContextKind {
  if (!ctx) return 'empty';
  if (ctx.bundleId) return 'bundle';
  // Standalone = a session-only context with no bundle binding. Classify on the
  // PRESENCE of session metadata (sessionId or transcriptPath), not the specific
  // id value — the value is a clobberable hint, but presence-vs-absence is
  // stable under co-tenancy.
  if (ctx.sessionId || ctx.transcriptPath) return 'standalone';
  return 'empty';
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
 * Resolve an assignment target across the three input shapes:
 *
 *   1. `--project <slug> + <assignment-slug>` (positional, explicit)
 *   2. bare UUID (positional, resolves standalone or project-nested via frontmatter id)
 *   3. no positional → the session's OPEN engagement (via `opts.resolveEngagement`).
 *      The legacy `.syntaur/context.json` assignment scalar is NO LONGER a
 *      resolution source — `context.json` is now a workspace marker only. With no
 *      positional and no open engagement, this throws the selector error.
 *
 * `--dir` overrides the projects base dir for cases 1 and 3 (project-nested).
 *
 * Throws AssignmentTargetError on any unresolved input. The returned shape
 * mirrors `ResolvedAssignment` from assignment-resolver.ts; Case 3 also carries
 * the engagement `stage`.
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

  // Case 3: no positional → resolve from the session's OPEN engagement.
  const cwd = opts.cwd ?? process.cwd();
  const ctx = await readContextJson(cwd);

  // Bundle context guard: surface a clear error so assignment-only flows (e.g.
  // /plan-assignment, /complete-assignment) don't misfire inside a bundle
  // worktree. The bundle-aware flows resolve via different helpers. context.json
  // still carries the bundle marker; only the assignment scalar was demoted.
  if (ctx && classifyContext(ctx) === 'bundle' && ctx.bundleId) {
    throw new AssignmentTargetError(
      `Context is bound to bundle b:${ctx.bundleId}, not an assignment. Use \`syntaur todo bundle show ${ctx.bundleId}\` or the complete-bundle skill.`,
    );
  }

  const binding = opts.resolveEngagement ? await opts.resolveEngagement() : null;
  if (binding) {
    return reconstructFromBinding(binding, baseDir);
  }

  throw new AssignmentTargetError(
    'No open engagement for this session. Pass --assignment <slug> (and --project) to target an assignment, or grab one first.',
  );
}

/**
 * Rebuild a `ResolvedAssignment` from the session's open-engagement binding.
 * Project-nested reconstructs `baseDir/<project>/assignments/<slug>`; standalone
 * uses the resolved `assignmentId` (preferred) or the slug-as-UUID under the
 * standalone assignments dir. Rejects a binding with no usable identity.
 */
async function reconstructFromBinding(
  binding: EngagementBinding,
  baseDir: string,
): Promise<ResolvedAssignment> {
  // Project-nested engagement.
  if (binding.projectSlug) {
    if (
      !isValidSlug(binding.projectSlug) ||
      !binding.assignmentSlug ||
      !isValidSlug(binding.assignmentSlug)
    ) {
      throw new AssignmentTargetError(
        `Open engagement has invalid slugs: project="${binding.projectSlug}" assignment="${binding.assignmentSlug}".`,
      );
    }
    const assignmentDir = resolve(baseDir, binding.projectSlug, 'assignments', binding.assignmentSlug);
    const assignmentMdPath = resolve(assignmentDir, 'assignment.md');
    if (!(await fileExists(assignmentMdPath))) {
      throw new AssignmentTargetError(
        `Open engagement points to a missing assignment: ${assignmentDir}.`,
      );
    }
    const id =
      (await readAssignmentFrontmatterId(assignmentDir)) ??
      binding.assignmentId ??
      binding.assignmentSlug;
    return {
      assignmentDir,
      projectSlug: binding.projectSlug,
      assignmentSlug: binding.assignmentSlug,
      id,
      standalone: false,
      workspaceGroup: null,
      stage: binding.stage,
    };
  }

  // Standalone engagement: prefer the resolved id, else the slug-as-UUID.
  const standaloneId = binding.assignmentId ?? binding.assignmentSlug;
  if (!standaloneId) {
    throw new AssignmentTargetError(
      'Open engagement has neither an assignment id nor a slug to resolve.',
    );
  }
  // The id becomes a path segment under the standalone assignments dir — reject
  // separators / traversal / absolute so a malformed DB binding can't resolve
  // outside assignmentsDir(). (Project-nested slugs go through isValidSlug above.)
  if (
    standaloneId.includes('/') ||
    standaloneId.includes('\\') ||
    standaloneId.includes('..') ||
    standaloneId.startsWith('.')
  ) {
    throw new AssignmentTargetError(
      `Open engagement has an unsafe standalone assignment id: "${standaloneId}".`,
    );
  }
  const dir = resolve(assignmentsDirFn(), standaloneId);
  const assignmentMdPath = resolve(dir, 'assignment.md');
  if (!(await fileExists(assignmentMdPath))) {
    throw new AssignmentTargetError(
      `Open engagement points to a missing standalone assignment: ${dir}.`,
    );
  }
  const id = (await readAssignmentFrontmatterId(dir)) ?? standaloneId;
  return {
    assignmentDir: dir,
    projectSlug: null,
    assignmentSlug: standaloneId,
    id,
    standalone: true,
    workspaceGroup: null,
    stage: binding.stage,
  };
}
