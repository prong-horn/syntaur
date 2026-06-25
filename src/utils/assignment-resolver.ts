import { resolve } from 'node:path';
import { readdir, readFile } from 'node:fs/promises';
import { fileExists } from './fs.js';
import { extractFrontmatter, getField } from '../dashboard/parser.js';

export interface ResolvedAssignment {
  assignmentDir: string;
  projectSlug: string | null;
  assignmentSlug: string;
  id: string;
  standalone: boolean;
  workspaceGroup: string | null;
  /**
   * The engagement stage this target was resolved at, when resolution came from
   * the session's open engagement (Case 3). Undefined for explicit `--project`
   * / bare-id resolution, which carries no engagement.
   */
  stage?: string;
}

export async function resolveAssignmentById(
  projectsDir: string,
  assignmentsDir: string,
  id: string,
): Promise<ResolvedAssignment | null> {
  let standaloneMatch: ResolvedAssignment | null = null;
  let projectMatch: ResolvedAssignment | null = null;

  // 1) Standalone: <assignmentsDir>/<id>/assignment.md
  const standaloneDir = resolve(assignmentsDir, id);
  const standalonePath = resolve(standaloneDir, 'assignment.md');
  if (await fileExists(standalonePath)) {
    let workspaceGroup: string | null = null;
    try {
      const content = await readFile(standalonePath, 'utf-8');
      const [fm] = extractFrontmatter(content);
      workspaceGroup = getField(fm, 'workspaceGroup');
    } catch {
      // unreadable — leave null
    }
    standaloneMatch = {
      assignmentDir: standaloneDir,
      projectSlug: null,
      assignmentSlug: id,
      id,
      standalone: true,
      workspaceGroup,
    };
  }

  // 2) Project-nested: scan <projectsDir>/*/assignments/*/assignment.md and match by frontmatter id
  if (await fileExists(projectsDir)) {
    try {
      const projects = await readdir(projectsDir, { withFileTypes: true });
      for (const p of projects) {
        if (!p.isDirectory()) continue;
        if (p.name.startsWith('.') || p.name.startsWith('_')) continue;
        const assignmentsPath = resolve(projectsDir, p.name, 'assignments');
        if (!(await fileExists(assignmentsPath))) continue;

        const entries = await readdir(assignmentsPath, { withFileTypes: true });
        for (const a of entries) {
          if (!a.isDirectory()) continue;
          const aPath = resolve(assignmentsPath, a.name, 'assignment.md');
          if (!(await fileExists(aPath))) continue;

          try {
            const content = await readFile(aPath, 'utf-8');
            const [fm] = extractFrontmatter(content);
            const fileId = getField(fm, 'id');
            if (fileId === id) {
              projectMatch = {
                assignmentDir: resolve(assignmentsPath, a.name),
                projectSlug: p.name,
                assignmentSlug: a.name,
                id,
                standalone: false,
                workspaceGroup: null,
              };
              break;
            }
          } catch {
            // skip unreadable
          }
        }
        if (projectMatch) break;
      }
    } catch {
      // projectsDir not readable
    }
  }

  if (standaloneMatch && projectMatch) {
    console.warn(
      `Duplicate assignment ID ${id} found in both standalone and project-nested locations; using standalone`,
    );
    return standaloneMatch;
  }

  return standaloneMatch ?? projectMatch ?? null;
}

export interface ResolvedAssignmentBySlug {
  /** True iff the assignment.md exists and is readable at the deterministic path. */
  exists: boolean;
  /** The frontmatter `id`, or null when the file is missing/unreadable/idless. */
  id: string | null;
}

/**
 * Resolve an assignment's frontmatter `id` (and existence) from its SLUGS via the
 * deterministic on-disk path — no directory scan. Project-nested:
 * `<projectsDir>/<projectSlug>/assignments/<assignmentSlug>/assignment.md`;
 * standalone (`projectSlug == null`): `<assignmentsDir>/<assignmentSlug>/assignment.md`.
 *
 * Returns `{exists:false, id:null}` when the file is absent/unreadable,
 * `{exists:true, id:null}` when it exists but has no frontmatter `id`, and
 * `{exists:true, id}` otherwise. Never throws — registration/binding callers use it
 * best-effort: M1 (track/grab/API) takes `.id` to store `assignment_id`; the L
 * dashboard-POST gate gates on `.exists`. Distinguishing missing-vs-idless is why
 * this returns a struct rather than `string | null`.
 */
export async function resolveAssignmentBySlug(
  projectsDir: string,
  assignmentsDir: string,
  projectSlug: string | null,
  assignmentSlug: string,
): Promise<ResolvedAssignmentBySlug> {
  const path = projectSlug
    ? resolve(projectsDir, projectSlug, 'assignments', assignmentSlug, 'assignment.md')
    : resolve(assignmentsDir, assignmentSlug, 'assignment.md');
  if (!(await fileExists(path))) return { exists: false, id: null };
  try {
    const content = await readFile(path, 'utf-8');
    const [fm] = extractFrontmatter(content);
    const id = getField(fm, 'id');
    return { exists: true, id: id ?? null };
  } catch {
    // exists on disk but unreadable — treat as not-resolvable (best-effort)
    return { exists: false, id: null };
  }
}
