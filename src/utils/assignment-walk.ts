import { resolve } from 'node:path';
import { readdir } from 'node:fs/promises';
import { fileExists } from './fs.js';

export interface AssignmentEntry {
  projectDir: string;
  /** `null` for standalone assignments (no containing project). */
  projectSlug: string | null;
  assignmentDir: string;
  /** For standalone, this is the UUID folder name. */
  assignmentSlug: string;
  standalone: boolean;
}

export interface AssignmentWalkResult {
  withAssignmentMd: AssignmentEntry[];
  orphanFolders: AssignmentEntry[];
}

export async function listAssignmentsByProject(
  projectsDir: string,
  standaloneDir: string | null,
): Promise<AssignmentWalkResult> {
  const result: AssignmentWalkResult = {
    withAssignmentMd: [],
    orphanFolders: [],
  };

  if (await fileExists(projectsDir)) {
    const projects = await readdir(projectsDir, { withFileTypes: true });
    for (const m of projects) {
      if (!m.isDirectory()) continue;
      if (m.name.startsWith('.') || m.name.startsWith('_')) continue;
      const assignmentsDir = resolve(projectsDir, m.name, 'assignments');
      if (!(await fileExists(assignmentsDir))) continue;

      const entries = await readdir(assignmentsDir, { withFileTypes: true });
      for (const a of entries) {
        if (!a.isDirectory()) continue;
        if (a.name.startsWith('.') || a.name.startsWith('_')) continue;
        const assignmentDir = resolve(assignmentsDir, a.name);
        const assignmentMd = resolve(assignmentDir, 'assignment.md');
        const entry: AssignmentEntry = {
          projectDir: resolve(projectsDir, m.name),
          projectSlug: m.name,
          assignmentDir,
          assignmentSlug: a.name,
          standalone: false,
        };
        if (await fileExists(assignmentMd)) {
          result.withAssignmentMd.push(entry);
        } else {
          result.orphanFolders.push(entry);
        }
      }
    }
  }

  if (standaloneDir !== null && (await fileExists(standaloneDir))) {
    const entries = await readdir(standaloneDir, { withFileTypes: true });
    for (const a of entries) {
      if (!a.isDirectory()) continue;
      if (a.name.startsWith('.') || a.name.startsWith('_')) continue;
      const assignmentDir = resolve(standaloneDir, a.name);
      const assignmentMd = resolve(assignmentDir, 'assignment.md');
      const entry: AssignmentEntry = {
        projectDir: standaloneDir,
        projectSlug: null,
        assignmentDir,
        assignmentSlug: a.name,
        standalone: true,
      };
      if (await fileExists(assignmentMd)) {
        result.withAssignmentMd.push(entry);
      } else {
        result.orphanFolders.push(entry);
      }
    }
  }

  return result;
}
