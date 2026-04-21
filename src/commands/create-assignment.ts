import { resolve } from 'node:path';
import { slugify, isValidSlug } from '../utils/slug.js';
import { nowTimestamp } from '../utils/timestamp.js';
import { generateId } from '../utils/uuid.js';
import { expandHome } from '../utils/paths.js';
import { ensureDir, writeFileForce, fileExists } from '../utils/fs.js';
import { readConfig } from '../utils/config.js';
import {
  renderAssignment,
  renderScratchpad,
  renderHandoff,
  renderDecisionRecord,
} from '../templates/index.js';
import { createProjectCommand } from './create-project.js';

export interface CreateAssignmentOptions {
  project?: string;
  oneOff?: boolean;
  slug?: string;
  priority?: 'low' | 'medium' | 'high' | 'critical';
  dependsOn?: string;
  links?: string;
  dir?: string;
}

export async function createAssignmentCommand(
  title: string,
  options: CreateAssignmentOptions,
): Promise<void> {
  if (!title.trim()) {
    throw new Error('Assignment title cannot be empty.');
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

  let projectSlug: string;
  let projectDir: string;

  const config = await readConfig();
  const baseDir = options.dir
    ? expandHome(options.dir)
    : config.defaultProjectDir;

  if (options.oneOff) {
    projectSlug = await createProjectCommand(title, {
      slug: assignmentSlug,
      dir: baseDir,
    });
    projectDir = resolve(baseDir, projectSlug);
  } else {
    projectSlug = options.project!;
    projectDir = resolve(baseDir, projectSlug);

    const projectMdPath = resolve(projectDir, 'project.md');
    if (!(await fileExists(projectDir)) || !(await fileExists(projectMdPath))) {
      throw new Error(
        `Project "${projectSlug}" not found at ${projectDir}.\nRun 'syntaur create-project' first or use --one-off.`,
      );
    }

    if (dependsOn.length > 0) {
      const assignmentsDir = resolve(projectDir, 'assignments');
      for (const dep of dependsOn) {
        const depDir = resolve(assignmentsDir, dep);
        if (!(await fileExists(depDir))) {
          console.warn(
            `Warning: dependency "${dep}" does not exist in project "${projectSlug}" yet.`,
          );
        }
      }
    }
  }

  const assignmentDir = resolve(
    projectDir,
    'assignments',
    assignmentSlug,
  );

  if (await fileExists(assignmentDir)) {
    throw new Error(
      `Assignment folder already exists: ${assignmentDir}\nUse --slug to specify a different slug.`,
    );
  }

  await ensureDir(assignmentDir);

  const timestamp = nowTimestamp();
  const id = generateId();

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
      }),
    ],
    [
      resolve(assignmentDir, 'scratchpad.md'),
      renderScratchpad({
        assignmentSlug,
        timestamp,
      }),
    ],
    [
      resolve(assignmentDir, 'handoff.md'),
      renderHandoff({
        assignmentSlug,
        timestamp,
      }),
    ],
    [
      resolve(assignmentDir, 'decision-record.md'),
      renderDecisionRecord({
        assignmentSlug,
        timestamp,
      }),
    ],
  ];

  for (const [filePath, content] of files) {
    await writeFileForce(filePath, content);
  }

  console.log(
    `Created assignment "${title}" in project "${projectSlug}" at ${assignmentDir}/`,
  );
  console.log(`  Slug: ${assignmentSlug}`);
  console.log(`  Priority: ${priority}`);
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
  console.log(
    `  Plan files (plan.md, plan-v2.md, ...) are created on demand by /plan-assignment.`,
  );
}
