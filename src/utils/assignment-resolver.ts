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
    standaloneMatch = {
      assignmentDir: standaloneDir,
      projectSlug: null,
      assignmentSlug: id,
      id,
      standalone: true,
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
