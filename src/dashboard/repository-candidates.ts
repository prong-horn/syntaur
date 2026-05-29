import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileExists } from '../utils/fs.js';
import { parseProject, parseAssignmentFull } from './parser.js';

export interface RepositoryCandidate {
  path: string;
  source: 'project' | 'sibling';
  /** Slug of the sibling assignment that provided this repo. Null for `project`-sourced. */
  sourceAssignmentSlug: string | null;
}

/**
 * A candidate assignment to "branch off" — one that already has a resolved
 * workspace (both `workspace.repository` and `workspace.branch` set). Branching
 * off it reuses its repository and uses its branch as the new worktree's parent.
 */
export interface SourceAssignment {
  /** Stable unique identifier (the assignment UUID). */
  id: string;
  slug: string;
  title: string;
  repository: string;
  branch: string;
}

/**
 * Build a {@link SourceAssignment} from a parsed assignment, or `null` when it
 * lacks a usable workspace (missing/blank repository or branch).
 */
function toSourceAssignment(
  parsed: ReturnType<typeof parseAssignmentFull>,
  fallbackId: string,
): SourceAssignment | null {
  const repository = parsed.workspace.repository?.trim();
  const branch = parsed.workspace.branch?.trim();
  if (!repository || !branch) return null;
  const slug = parsed.slug?.trim() || fallbackId;
  return {
    id: parsed.id?.trim() || fallbackId,
    slug,
    title: parsed.title?.trim() || slug,
    repository,
    branch,
  };
}

/**
 * Collect repository candidates for a project-nested assignment.
 *
 * Order: project-configured first (in declaration order), then
 * sibling-harvested from other assignments in the same project. Deduped by
 * absolute path; the first occurrence wins. Missing project.md or assignments
 * directory returns `[]`.
 */
export async function getProjectRepositoryCandidates(
  projectsDir: string,
  projectSlug: string,
): Promise<RepositoryCandidate[]> {
  const seen = new Set<string>();
  const out: RepositoryCandidate[] = [];

  const projectPath = resolve(projectsDir, projectSlug, 'project.md');
  if (await fileExists(projectPath)) {
    const project = parseProject(await readFile(projectPath, 'utf-8'));
    for (const raw of project.repositories) {
      const path = raw.trim();
      if (!path) continue;
      const abs = resolve(path);
      if (seen.has(abs)) continue;
      seen.add(abs);
      out.push({ path: abs, source: 'project', sourceAssignmentSlug: null });
    }
  }

  const assignmentsDir = resolve(projectsDir, projectSlug, 'assignments');
  if (await fileExists(assignmentsDir)) {
    const entries = await readdir(assignmentsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const assignmentMd = resolve(assignmentsDir, entry.name, 'assignment.md');
      if (!(await fileExists(assignmentMd))) continue;
      const parsed = parseAssignmentFull(await readFile(assignmentMd, 'utf-8'));
      const repo = parsed.workspace.repository?.trim();
      if (!repo) continue;
      const abs = resolve(repo);
      if (seen.has(abs)) continue;
      seen.add(abs);
      out.push({ path: abs, source: 'sibling', sourceAssignmentSlug: parsed.slug });
    }
  }

  return out;
}

/**
 * Collect repository candidates for a standalone assignment by harvesting
 * `workspace.repository` from sibling standalone assignments. Excludes the
 * assignment id passed in (typically the one the user is configuring).
 */
export async function getStandaloneRepositoryCandidates(
  assignmentsDir: string,
  excludeAssignmentId: string,
): Promise<RepositoryCandidate[]> {
  if (!(await fileExists(assignmentsDir))) {
    return [];
  }

  const seen = new Set<string>();
  const out: RepositoryCandidate[] = [];

  const entries = await readdir(assignmentsDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name === excludeAssignmentId) continue;
    const assignmentMd = resolve(assignmentsDir, entry.name, 'assignment.md');
    if (!(await fileExists(assignmentMd))) continue;
    const parsed = parseAssignmentFull(await readFile(assignmentMd, 'utf-8'));
    const repo = parsed.workspace.repository?.trim();
    if (!repo) continue;
    const abs = resolve(repo);
    if (seen.has(abs)) continue;
    seen.add(abs);
    out.push({ path: abs, source: 'sibling', sourceAssignmentSlug: parsed.slug });
  }

  return out;
}

/**
 * List sibling assignments in a project that can be branched off (both
 * `workspace.repository` and `workspace.branch` are set). Excludes the
 * assignment being configured and dedupes by slug (the project dir name, which
 * is unique within a project). Missing assignments directory returns `[]`.
 */
export async function getProjectSourceAssignments(
  projectsDir: string,
  projectSlug: string,
  excludeSlug: string,
): Promise<SourceAssignment[]> {
  const assignmentsDir = resolve(projectsDir, projectSlug, 'assignments');
  if (!(await fileExists(assignmentsDir))) return [];

  const seen = new Set<string>();
  const out: SourceAssignment[] = [];

  const entries = await readdir(assignmentsDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name === excludeSlug) continue;
    const assignmentMd = resolve(assignmentsDir, entry.name, 'assignment.md');
    if (!(await fileExists(assignmentMd))) continue;
    const parsed = parseAssignmentFull(await readFile(assignmentMd, 'utf-8'));
    const source = toSourceAssignment(parsed, entry.name);
    if (!source) continue;
    // Exclude + dedupe by the directory name (route-authoritative, unique within
    // the project) rather than parsed frontmatter, which could be malformed.
    if (seen.has(entry.name)) continue;
    seen.add(entry.name);
    out.push(source);
  }

  return out;
}

/**
 * List standalone assignments that can be branched off (both
 * `workspace.repository` and `workspace.branch` are set). Excludes the
 * assignment being configured and dedupes by the UUID `id` (standalone slugs
 * are display-only and may collide). Missing directory returns `[]`.
 */
export async function getStandaloneSourceAssignments(
  assignmentsDir: string,
  excludeAssignmentId: string,
): Promise<SourceAssignment[]> {
  if (!(await fileExists(assignmentsDir))) return [];

  const seen = new Set<string>();
  const out: SourceAssignment[] = [];

  const entries = await readdir(assignmentsDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name === excludeAssignmentId) continue;
    const assignmentMd = resolve(assignmentsDir, entry.name, 'assignment.md');
    if (!(await fileExists(assignmentMd))) continue;
    const parsed = parseAssignmentFull(await readFile(assignmentMd, 'utf-8'));
    const source = toSourceAssignment(parsed, entry.name);
    if (!source) continue;
    // Exclude + dedupe by the directory name (the authoritative UUID) rather
    // than parsed frontmatter.
    if (seen.has(entry.name)) continue;
    seen.add(entry.name);
    out.push(source);
  }

  return out;
}
