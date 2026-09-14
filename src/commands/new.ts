import { resolve } from 'node:path';
import { slugify, isValidSlug } from '../utils/slug.js';
import { nowTimestamp } from '../utils/timestamp.js';
import { allocateTicketId, isTicketId } from '../utils/ticket-ids.js';
import { expandHome, syntaurRoot } from '../utils/paths.js';
import { ensureDir, writeFileForce, fileExists } from '../utils/fs.js';
import { readFile } from 'node:fs/promises';
import { readConfig } from '../utils/config.js';
import { ensureScratchProject } from '../utils/scratch-project.js';
import { formatTicketFolderName } from '../utils/ticket-folder.js';
import { resolveTicketById } from '../utils/ticket-resolver.js';
import {
  listTemplates,
  loadTemplate,
  resolveTemplateContentDir,
} from '../ticket-templates/registry.js';
import { seedMissingBuiltins } from '../ticket-templates/builtins.js';
import {
  scaffoldTemplateFiles,
  scaffoldedPlanPaths,
} from '../ticket-templates/scaffold.js';
import { parseProject } from '../dashboard/parser.js';
import { renderTicket } from '../templates/index.js';
import { updatePlanBlock } from '../lifecycle/frontmatter.js';

export interface NewTicketOptions {
  project?: string;
  slug?: string;
  priority?: 'low' | 'medium' | 'high' | 'critical';
  depends_on_flag?: string;
  links?: string;
  dir?: string;
  template?: string;
  workflow?: string;
  silent?: boolean;
  ready?: boolean;
  acceptanceCriteria?: string[];
}

export interface NewTicketResult {
  id: string;
  slug: string;
  projectSlug: string;
  ticketDir: string;
  written: string[];
}

async function resolveDefaultTemplate(projectDir: string): Promise<string> {
  const projectMd = resolve(projectDir, 'project.md');
  if (await fileExists(projectMd)) {
    const content = await readFile(projectMd, 'utf-8');
    const project = parseProject(content);
    if (project.defaultTemplate) return project.defaultTemplate;
  }
  return 'feature';
}

export async function newCommand(
  title: string,
  options: NewTicketOptions,
): Promise<NewTicketResult> {
  if (!title.trim()) {
    throw new Error('Ticket title cannot be empty.');
  }

  const config = await readConfig();
  const root = syntaurRoot();
  const baseDir = options.dir ? expandHome(options.dir) : config.defaultProjectDir;

  const projectSlug = options.project ?? await ensureScratchProject(baseDir);

  if (!isValidSlug(projectSlug)) {
    throw new Error(
      `Invalid project slug "${projectSlug}". Slugs must be lowercase, hyphen-separated, with no special characters.`,
    );
  }

  const ticketSlug = options.slug || slugify(title);
  if (!isValidSlug(ticketSlug)) {
    throw new Error(
      `Invalid slug "${ticketSlug}". Slugs must be lowercase, hyphen-separated, with no special characters.`,
    );
  }

  const depends_on = options.depends_on_flag
    ? options.depends_on_flag.split(',').map((s) => s.trim()).filter(Boolean)
    : [];
  for (const dep of depends_on) {
    if (!isTicketId(dep)) {
      throw new Error(
        `Invalid dependency id "${dep}". depends_on entries must be ticket ids (e.g. SCR-1).`,
      );
    }
    const resolved = await resolveTicketById(baseDir, dep);
    if (!resolved) {
      console.warn(`Warning: dependency "${dep}" was not found on disk yet.`);
    }
  }

  const links = options.links
    ? options.links.split(',').map((s) => s.trim()).filter(Boolean)
    : [];
  for (const link of links) {
    if (!isTicketId(link)) {
      throw new Error(
        `Invalid link "${link}". Links must be ticket ids (e.g. SCR-2).`,
      );
    }
    const resolved = await resolveTicketById(baseDir, link);
    if (!resolved) {
      console.warn(`Warning: linked ticket "${link}" was not found on disk yet.`);
    }
  }

  const timestamp = nowTimestamp();
  const projectDir = resolve(baseDir, projectSlug);
  const projectMdPath = resolve(projectDir, 'project.md');
  if (!(await fileExists(projectDir)) || !(await fileExists(projectMdPath))) {
    throw new Error(
      `Project "${projectSlug}" not found at ${projectDir}.\nRun 'syntaur project new' first.`,
    );
  }

  await seedMissingBuiltins(root);
  const templates = await listTemplates(root);
  const templateIds = templates.map((t) => t.id);
  const templateId =
    options.template ?? (await resolveDefaultTemplate(projectDir));
  if (!templateIds.includes(templateId)) {
    throw new Error(
      `Unknown template "${templateId}". Available: ${templateIds.join(', ')} (syntaur template list)`,
    );
  }

  const manifest = await loadTemplate(root, templateId);
  const templateDir = await resolveTemplateContentDir(root, templateId);

  const validPriorities = ['low', 'medium', 'high', 'critical'] as const;
  const priority = (options.priority ?? manifest.defaultPriority) as typeof validPriorities[number];
  if (!validPriorities.includes(priority)) {
    throw new Error(
      `Invalid priority "${options.priority ?? manifest.defaultPriority}". Must be one of: ${validPriorities.join(', ')}`,
    );
  }

  const id = await allocateTicketId(projectDir);
  const folderName = formatTicketFolderName(id, ticketSlug);
  const ticketDir = resolve(projectDir, 'tickets', folderName);

  if (await fileExists(ticketDir)) {
    throw new Error(
      `Ticket folder already exists: ${ticketDir}\nUse --slug to specify a different slug.`,
    );
  }

  await ensureDir(ticketDir);

  let ticketContent = renderTicket({
    id,
    slug: ticketSlug,
    title,
    timestamp,
    priority,
    depends_on,
    links,
    project: projectSlug,
    template: templateId,
    workflow: options.workflow ?? null,
    status: options.ready ? 'ready_for_planning' : 'draft',
    acceptanceCriteria: options.acceptanceCriteria,
  });

  const written = await scaffoldTemplateFiles({
    ticketDir,
    templateDir,
    template: manifest,
    ticketSlug,
    ticketTitle: title,
    timestamp,
    when: 'ticket-creation',
  });

  const planWritten = scaffoldedPlanPaths(written, manifest);
  if (planWritten.length > 0) {
    ticketContent = updatePlanBlock(ticketContent, {
      file: planWritten[0],
      approvedDigest: null,
      approvedAt: null,
      approvedBy: null,
    });
  }

  await writeFileForce(resolve(ticketDir, 'ticket.md'), ticketContent);

  const allWritten = ['ticket.md', ...written];

  if (!options.silent) {
    console.log(
      `Created ticket "${title}" in project "${projectSlug}" at ${ticketDir}/`,
    );
    console.log(`  Id: ${id}`);
    console.log(`  Slug: ${ticketSlug}`);
    console.log(`  Priority: ${priority}`);
    console.log(`  Template: ${templateId}`);
    if (depends_on.length > 0) {
      console.log(`  Depends on: ${depends_on.join(', ')}`);
    }
    if (links.length > 0) {
      console.log(`  Links: ${links.join(', ')}`);
    }
    console.log(`  Files created:`);
    for (const f of allWritten) {
      console.log(`    ${f}`);
    }
  }

  return { id, slug: ticketSlug, projectSlug, ticketDir, written: allWritten };
}
