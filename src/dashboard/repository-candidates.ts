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
