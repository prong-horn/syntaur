import { resolve } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { expandHome, assignmentsDir as assignmentsDirFn } from '../utils/paths.js';
import { fileExists } from '../utils/fs.js';
import { readConfig } from '../utils/config.js';
import { isValidSlug } from '../utils/slug.js';
import { updateAssignmentFile } from '../lifecycle/frontmatter.js';
import { nowTimestamp } from '../utils/timestamp.js';
import { resolveAssignmentById } from '../utils/assignment-resolver.js';

export interface ArchiveOptions {
  project?: string;
  reason?: string;
  dir?: string;
}

export interface ArchiveResult {
  success: boolean;
  message: string;
}

type TargetKind = 'assignment' | 'project';

interface ResolvedTarget {
  kind: TargetKind;
  /** Path to the frontmatter file to mutate (assignment.md or project.md). */
  filePath: string;
  /** Human-readable label for messages. */
  label: string;
}

/**
 * Resolve an `archive`/`restore` target to a concrete frontmatter file.
 * Order (see plan D4): `--project <slug>` → project-scoped assignment; else a
 * UUID/standalone via resolveAssignmentById; else treat `target` as a project
 * slug; else `null`.
 */
async function resolveTarget(target: string, options: ArchiveOptions): Promise<ResolvedTarget | null> {
  const config = await readConfig();
  const baseDir = options.dir ? expandHome(options.dir) : config.defaultProjectDir;

  // 1. Project-scoped assignment via --project.
  if (options.project) {
    if (!isValidSlug(options.project)) {
      throw new Error(`Invalid project slug "${options.project}".`);
    }
    if (!isValidSlug(target)) {
      throw new Error(`Invalid assignment slug "${target}".`);
    }
    const assignmentMd = resolve(baseDir, options.project, 'assignments', target, 'assignment.md');
    if (!(await fileExists(assignmentMd))) {
      throw new Error(`Assignment "${target}" not found in project "${options.project}".`);
    }
    return { kind: 'assignment', filePath: assignmentMd, label: `assignment "${options.project}/${target}"` };
  }

  // 2. Assignment by UUID (standalone or project-nested).
  const resolved = await resolveAssignmentById(baseDir, assignmentsDirFn(), target);
  if (resolved) {
    return {
      kind: 'assignment',
      filePath: resolve(resolved.assignmentDir, 'assignment.md'),
      label: resolved.projectSlug
        ? `assignment "${resolved.projectSlug}/${resolved.assignmentSlug}"`
        : `assignment "${target}"`,
    };
  }

  // 3. Project slug.
  const projectMd = resolve(baseDir, target, 'project.md');
  if (await fileExists(projectMd)) {
    return { kind: 'project', filePath: projectMd, label: `project "${target}"` };
  }

  return null;
}

async function writeArchiveState(
  filePath: string,
  archived: boolean,
  reason: string | null,
): Promise<void> {
  const content = await readFile(filePath, 'utf-8');
  const updated = updateAssignmentFile(content, {
    archived,
    archivedAt: archived ? nowTimestamp() : null,
    archivedReason: archived ? reason : null,
    updated: nowTimestamp(),
  });
  await writeFile(filePath, updated, 'utf-8');
}

export async function runArchive(target: string, options: ArchiveOptions = {}): Promise<ArchiveResult> {
  const resolved = await resolveTarget(target, options);
  if (!resolved) {
    return { success: false, message: `No assignment or project matched "${target}".` };
  }
  await writeArchiveState(resolved.filePath, true, options.reason ?? null);
  return { success: true, message: `Archived ${resolved.label}.` };
}

export async function runRestore(target: string, options: ArchiveOptions = {}): Promise<ArchiveResult> {
  const resolved = await resolveTarget(target, options);
  if (!resolved) {
    return { success: false, message: `No assignment or project matched "${target}".` };
  }
  await writeArchiveState(resolved.filePath, false, null);
  return { success: true, message: `Restored ${resolved.label}.` };
}

export function reportArchiveResult(result: ArchiveResult): void {
  if (!result.success) {
    throw new Error(result.message);
  }
  console.log(result.message);
}
