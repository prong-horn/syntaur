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
import { createMissionCommand } from './create-mission.js';

export interface CreateAssignmentOptions {
  mission?: string;
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

  if (!options.mission && !options.oneOff) {
    throw new Error(
      'Either --mission <slug> or --one-off is required.',
    );
  }
  if (options.mission && options.oneOff) {
    throw new Error(
      'Cannot use both --mission and --one-off. Use --mission to add to an existing mission, or --one-off to create a standalone assignment.',
    );
  }

  if (options.mission && !isValidSlug(options.mission)) {
    throw new Error(
      `Invalid mission slug "${options.mission}". Slugs must be lowercase, hyphen-separated, with no special characters.`,
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
        `Invalid link "${link}". Links must be in missionSlug/assignmentSlug format (e.g., "my-mission/my-assignment").`,
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

  let missionSlug: string;
  let missionDir: string;

  const config = await readConfig();
  const baseDir = options.dir
    ? expandHome(options.dir)
    : config.defaultMissionDir;

  if (options.oneOff) {
    missionSlug = await createMissionCommand(title, {
      slug: assignmentSlug,
      dir: baseDir,
    });
    missionDir = resolve(baseDir, missionSlug);
  } else {
    missionSlug = options.mission!;
    missionDir = resolve(baseDir, missionSlug);

    const missionMdPath = resolve(missionDir, 'mission.md');
    if (!(await fileExists(missionDir)) || !(await fileExists(missionMdPath))) {
      throw new Error(
        `Mission "${missionSlug}" not found at ${missionDir}.\nRun 'syntaur create-mission' first or use --one-off.`,
      );
    }

    if (dependsOn.length > 0) {
      const assignmentsDir = resolve(missionDir, 'assignments');
      for (const dep of dependsOn) {
        const depDir = resolve(assignmentsDir, dep);
        if (!(await fileExists(depDir))) {
          console.warn(
            `Warning: dependency "${dep}" does not exist in mission "${missionSlug}" yet.`,
          );
        }
      }
    }
  }

  const assignmentDir = resolve(
    missionDir,
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
    `Created assignment "${title}" in mission "${missionSlug}" at ${assignmentDir}/`,
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
