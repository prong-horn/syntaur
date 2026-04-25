import { resolve } from 'node:path';
import { slugify, isValidSlug } from '../utils/slug.js';
import { nowTimestamp } from '../utils/timestamp.js';
import { generateId } from '../utils/uuid.js';
import { expandHome, assignmentsDir as assignmentsDirFn } from '../utils/paths.js';
import { ensureDir, writeFileForce, fileExists } from '../utils/fs.js';
import { readConfig } from '../utils/config.js';
import {
  renderAssignment,
  renderScratchpad,
  renderHandoff,
  renderDecisionRecord,
  renderProgress,
  renderComments,
} from '../templates/index.js';

export interface CreateAssignmentOptions {
  project?: string;
  oneOff?: boolean;
  slug?: string;
  priority?: 'low' | 'medium' | 'high' | 'critical';
  dependsOn?: string;
  links?: string;
  dir?: string;
  type?: string;
  withTodos?: boolean;
  workspace?: string;
}

export async function createAssignmentCommand(
  title: string,
  options: CreateAssignmentOptions,
): Promise<void> {
  if (!title.trim()) {
    throw new Error('Assignment title cannot be empty.');
  }

  // --workspace guards run before the generic --project/--one-off guard so that
  // `--workspace <slug>` alone reports the actionable message rather than the
  // generic "Either --project or --one-off is required." error.
  if (options.workspace && options.project) {
    throw new Error(
      'Cannot use --workspace with --project (projects already carry a workspace via project.workspace).',
    );
  }
  if (options.workspace && !options.oneOff) {
    throw new Error('--workspace requires --one-off.');
  }

  if (!options.project && !options.oneOff) {
    throw new Error(
      'Either --project <slug> or --one-off is required.',
    );
  }
  if (options.project && options.oneOff) {
    throw new Error(
      'Cannot use both --project and --one-off. Use --project to add to an existing project, or --one-off to create a standalone assignment.',
    );
  }

  if (options.project && !isValidSlug(options.project)) {
    throw new Error(
      `Invalid project slug "${options.project}". Slugs must be lowercase, hyphen-separated, with no special characters.`,
    );
  }

  // Stricter than server.ts:240 / createProjectCommand by design — assignment slugs already use isValidSlug.
  if (options.workspace && !isValidSlug(options.workspace)) {
    throw new Error(
      `Invalid workspace slug "${options.workspace}". Slugs must be lowercase, hyphen-separated, with no special characters.`,
    );
  }

  if (options.oneOff && options.dependsOn) {
    throw new Error('Standalone assignments cannot have dependencies (--depends-on is not allowed with --one-off).');
  }

  const assignmentSlug = options.slug || slugify(title);
  if (!isValidSlug(assignmentSlug)) {
    throw new Error(
      `Invalid slug "${assignmentSlug}". Slugs must be lowercase, hyphen-separated, with no special characters.`,
    );
  }

  const dependsOn = options.dependsOn
    ? options.dependsOn.split(',').map((s) => s.trim()).filter(Boolean)
    : [];
  for (const dep of dependsOn) {
    if (!isValidSlug(dep)) {
      throw new Error(
        `Invalid dependency slug "${dep}". Slugs must be lowercase, hyphen-separated, with no special characters.`,
      );
    }
  }

  const links = options.links
    ? options.links.split(',').map((s) => s.trim()).filter(Boolean)
    : [];
  for (const link of links) {
    const parts = link.split('/');
    if (parts.length !== 2 || !parts.every(isValidSlug)) {
      throw new Error(
        `Invalid link "${link}". Links must be in projectSlug/assignmentSlug format (e.g., "my-project/my-assignment").`,
      );
    }
  }

  const validPriorities = ['low', 'medium', 'high', 'critical'] as const;
  const priority = (options.priority || 'medium') as typeof validPriorities[number];
  if (!validPriorities.includes(priority)) {
    throw new Error(
      `Invalid priority "${options.priority}". Must be one of: ${validPriorities.join(', ')}`,
    );
  }

  const config = await readConfig();
  const timestamp = nowTimestamp();
  const id = generateId();

  let assignmentDir: string;
  let projectSlug: string | null;
  let folderName: string;

  if (options.oneOff) {
    // Standalone: folder name = UUID, project: null
    const standaloneRoot = assignmentsDirFn();
    folderName = id;
    assignmentDir = resolve(standaloneRoot, folderName);
    projectSlug = null;
    await ensureDir(standaloneRoot);
  } else {
    const baseDir = options.dir
      ? expandHome(options.dir)
      : config.defaultProjectDir;
    projectSlug = options.project!;
    const projectDir = resolve(baseDir, projectSlug);

    const projectMdPath = resolve(projectDir, 'project.md');
    if (!(await fileExists(projectDir)) || !(await fileExists(projectMdPath))) {
      throw new Error(
        `Project "${projectSlug}" not found at ${projectDir}.\nRun 'syntaur create-project' first or use --one-off.`,
      );
    }

    if (dependsOn.length > 0) {
      const depDirBase = resolve(projectDir, 'assignments');
      for (const dep of dependsOn) {
        const depDir = resolve(depDirBase, dep);
        if (!(await fileExists(depDir))) {
          console.warn(
            `Warning: dependency "${dep}" does not exist in project "${projectSlug}" yet.`,
          );
        }
      }
    }

    folderName = assignmentSlug;
    assignmentDir = resolve(projectDir, 'assignments', folderName);
  }

  if (await fileExists(assignmentDir)) {
    throw new Error(
      `Assignment folder already exists: ${assignmentDir}\nUse --slug to specify a different slug.`,
    );
  }

  await ensureDir(assignmentDir);

  const companionAssignmentRef = projectSlug === null ? id : assignmentSlug;

  const files: Array<[string, string]> = [
    [
      resolve(assignmentDir, 'assignment.md'),
      renderAssignment({
        id,
        slug: assignmentSlug,
        title,
        timestamp,
        priority,
        dependsOn,
        links,
        project: projectSlug,
        workspaceGroup: options.workspace ?? null,
        type: options.type,
        includeTodos: options.withTodos === true,
      }),
    ],
    [
      resolve(assignmentDir, 'scratchpad.md'),
      renderScratchpad({
        assignmentSlug: companionAssignmentRef,
        timestamp,
      }),
    ],
    [
      resolve(assignmentDir, 'handoff.md'),
      renderHandoff({
        assignmentSlug: companionAssignmentRef,
        timestamp,
      }),
    ],
    [
      resolve(assignmentDir, 'decision-record.md'),
      renderDecisionRecord({
        assignmentSlug: companionAssignmentRef,
        timestamp,
      }),
    ],
    [
      resolve(assignmentDir, 'progress.md'),
      renderProgress({
        assignment: companionAssignmentRef,
        timestamp,
      }),
    ],
    [
      resolve(assignmentDir, 'comments.md'),
      renderComments({
        assignment: companionAssignmentRef,
        timestamp,
      }),
    ],
  ];

  for (const [filePath, content] of files) {
    await writeFileForce(filePath, content);
  }

  if (projectSlug === null) {
    console.log(
      `Created standalone assignment "${title}" at ${assignmentDir}/`,
    );
    console.log(`  UUID: ${id}`);
    console.log(`  Slug: ${assignmentSlug} (display only)`);
  } else {
    console.log(
      `Created assignment "${title}" in project "${projectSlug}" at ${assignmentDir}/`,
    );
    console.log(`  Slug: ${assignmentSlug}`);
  }
  console.log(`  Priority: ${priority}`);
  if (options.type) {
    console.log(`  Type: ${options.type}`);
  }
  if (dependsOn.length > 0) {
    console.log(`  Depends on: ${dependsOn.join(', ')}`);
  }
  if (links.length > 0) {
    console.log(`  Links: ${links.join(', ')}`);
  }
  console.log(`  Files created:`);
  console.log(`    assignment.md`);
  console.log(`    scratchpad.md`);
  console.log(`    handoff.md`);
  console.log(`    decision-record.md`);
  console.log(`    progress.md`);
  console.log(`    comments.md`);
  console.log(
    `  Plan files (plan.md, plan-v2.md, ...) are created on demand by /plan-assignment.`,
  );
}
