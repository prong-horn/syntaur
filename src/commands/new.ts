import { resolve } from 'node:path';
import { slugify, isValidSlug } from '../utils/slug.js';
import { nowTimestamp } from '../utils/timestamp.js';
import { generateId } from '../utils/uuid.js';
import { expandHome, ticketsDir as ticketsDirFn } from '../utils/paths.js';
import { ensureDir, writeFileForce, fileExists } from '../utils/fs.js';
import { readConfig } from '../utils/config.js';
import {
  renderTicket,
  renderScratchpad,
  renderHandoff,
  renderDecisionRecord,
  renderProgress,
  renderComments,
} from '../templates/index.js';

export interface NewTicketOptions {
  project?: string;
  oneOff?: boolean;
  slug?: string;
  priority?: 'low' | 'medium' | 'high' | 'critical';
  dependsOn?: string;
  links?: string;
  dir?: string;
  type?: string;
  workflow?: string;
  silent?: boolean;
  ready?: boolean;
  acceptanceCriteria?: string[];
}

export interface NewTicketResult {
  id: string;
  slug: string;
  projectSlug: string | null;
  ticketDir: string;
}

export async function newCommand(
  title: string,
  options: NewTicketOptions,
): Promise<NewTicketResult> {
  if (!title.trim()) {
    throw new Error('Ticket title cannot be empty.');
  }

  if (!options.project && !options.oneOff) {
    throw new Error(
      'Either --project <slug> or --one-off is required.',
    );
  }
  if (options.project && options.oneOff) {
    throw new Error(
      'Cannot use both --project and --one-off. Use --project to add to an existing project, or --one-off to create a standalone ticket.',
    );
  }

  if (options.project && !isValidSlug(options.project)) {
    throw new Error(
      `Invalid project slug "${options.project}". Slugs must be lowercase, hyphen-separated, with no special characters.`,
    );
  }

  if (options.oneOff && options.dependsOn) {
    throw new Error('Standalone tickets cannot have dependencies (--depends-on is not allowed with --one-off).');
  }

  const ticketSlug = options.slug || slugify(title);
  if (!isValidSlug(ticketSlug)) {
    throw new Error(
      `Invalid slug "${ticketSlug}". Slugs must be lowercase, hyphen-separated, with no special characters.`,
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
        `Invalid link "${link}". Links must be in projectSlug/ticketSlug format (e.g., "my-project/my-assignment").`,
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

  let ticketDir: string;
  let projectSlug: string | null;
  let folderName: string;

  if (options.oneOff) {
    // Standalone: folder name = UUID, project: null
    const standaloneRoot = ticketsDirFn();
    folderName = id;
    ticketDir = resolve(standaloneRoot, folderName);
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
      const depDirBase = resolve(projectDir, 'tickets');
      for (const dep of dependsOn) {
        const depDir = resolve(depDirBase, dep);
        if (!(await fileExists(depDir))) {
          console.warn(
            `Warning: dependency "${dep}" does not exist in project "${projectSlug}" yet.`,
          );
        }
      }
    }

    folderName = ticketSlug;
    ticketDir = resolve(projectDir, 'tickets', folderName);
  }

  if (await fileExists(ticketDir)) {
    throw new Error(
      `Ticket folder already exists: ${ticketDir}\nUse --slug to specify a different slug.`,
    );
  }

  await ensureDir(ticketDir);

  const companionAssignmentRef = projectSlug === null ? id : ticketSlug;

  const files: Array<[string, string]> = [
    [
      resolve(ticketDir, 'ticket.md'),
      renderTicket({
        id,
        slug: ticketSlug,
        title,
        timestamp,
        priority,
        dependsOn,
        links,
        project: projectSlug,
        type: options.type,
        workflow: options.workflow ?? null,
        status: options.ready ? 'ready_for_planning' : 'draft',
        acceptanceCriteria: options.acceptanceCriteria,
      }),
    ],
    [
      resolve(ticketDir, 'scratchpad.md'),
      renderScratchpad({
        ticketSlug: companionAssignmentRef,
        timestamp,
      }),
    ],
    [
      resolve(ticketDir, 'handoff.md'),
      renderHandoff({
        ticketSlug: companionAssignmentRef,
        timestamp,
      }),
    ],
    [
      resolve(ticketDir, 'decision-record.md'),
      renderDecisionRecord({
        ticketSlug: companionAssignmentRef,
        timestamp,
      }),
    ],
    [
      resolve(ticketDir, 'progress.md'),
      renderProgress({
        ticket: companionAssignmentRef,
        timestamp,
      }),
    ],
    [
      resolve(ticketDir, 'comments.md'),
      renderComments({
        ticket: companionAssignmentRef,
        timestamp,
      }),
    ],
  ];

  for (const [filePath, content] of files) {
    await writeFileForce(filePath, content);
  }

  if (!options.silent) {
    if (projectSlug === null) {
      console.log(
        `Created standalone ticket "${title}" at ${ticketDir}/`,
      );
      console.log(`  UUID: ${id}`);
      console.log(`  Slug: ${ticketSlug} (display only)`);
    } else {
      console.log(
        `Created ticket "${title}" in project "${projectSlug}" at ${ticketDir}/`,
      );
      console.log(`  Slug: ${ticketSlug}`);
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
    console.log(`    ticket.md`);
    console.log(`    scratchpad.md`);
    console.log(`    handoff.md`);
    console.log(`    decision-record.md`);
    console.log(`    progress.md`);
    console.log(`    comments.md`);
    console.log(
      `  Plan files (plan.md, plan-v2.md, ...) are created on demand by /plan-assignment.`,
    );
  }

  return { id, slug: ticketSlug, projectSlug, ticketDir };
}
