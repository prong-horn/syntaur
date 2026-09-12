import { Command } from 'commander';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { slugify, isValidSlug } from '../utils/slug.js';
import { nowTimestamp } from '../utils/timestamp.js';
import { generateId } from '../utils/uuid.js';
import { expandHome } from '../utils/paths.js';
import { fileExists } from '../utils/fs.js';
import { readConfig } from '../utils/config.js';
import { writeProjectScaffold } from '../utils/project-scaffold.js';
import {
  collectExistingPrefixes,
  derivePrefix,
} from '../utils/ticket-ids.js';
import { parseProject } from '../dashboard/parser.js';

export interface ProjectNewOptions {
  slug?: string;
  prefix?: string;
  dir?: string;
  silent?: boolean;
}

export async function projectNewCommand(
  title: string,
  options: ProjectNewOptions,
): Promise<string> {
  if (!title.trim()) {
    throw new Error('Project title cannot be empty.');
  }

  const slug = options.slug || slugify(title);
  if (!isValidSlug(slug)) {
    throw new Error(
      `Invalid slug "${slug}". Slugs must be lowercase, hyphen-separated, with no special characters.`,
    );
  }

  const config = await readConfig();
  const baseDir = options.dir
    ? expandHome(options.dir)
    : config.defaultProjectDir;
  const projectDir = resolve(baseDir, slug);

  if (await fileExists(projectDir)) {
    throw new Error(
      `Project folder already exists: ${projectDir}\nUse --slug to specify a different slug.`,
    );
  }

  const existingPrefixes = await collectExistingPrefixes(baseDir);
  let prefix = options.prefix?.toUpperCase();
  if (prefix) {
    if (!/^[A-Z]{2,5}$/.test(prefix)) {
      throw new Error(
        `Invalid prefix "${prefix}". Must be 2–5 uppercase letters.`,
      );
    }
    if (existingPrefixes.has(prefix)) {
      throw new Error(`Prefix "${prefix}" is already in use by another project.`);
    }
  } else {
    prefix = derivePrefix(slug, existingPrefixes);
  }

  const timestamp = nowTimestamp();
  const id = generateId();

  await writeProjectScaffold(projectDir, {
    slug,
    title,
    prefix,
    nextTicket: 1,
    id,
    timestamp,
  });

  if (!options.silent) {
    console.log(`Created project "${title}" at ${projectDir}/`);
    console.log(`  Slug: ${slug}`);
    console.log(`  Prefix: ${prefix}`);
    console.log(`  Files created:`);
    console.log(`    manifest.md`);
    console.log(`    project.md`);
    console.log(`    _index-tickets.md`);
    console.log(`    _index-plans.md`);
    console.log(`    _index-decisions.md`);
    console.log(`    _status.md`);
  }

  return slug;
}

export async function projectListCommand(dir?: string): Promise<void> {
  const config = await readConfig();
  const baseDir = dir ? expandHome(dir) : config.defaultProjectDir;
  if (!(await fileExists(baseDir))) {
    console.log('No projects directory found.');
    return;
  }

  const entries = await readdir(baseDir, { withFileTypes: true });
  const rows: Array<{ slug: string; title: string; prefix: string }> = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const projectMd = resolve(baseDir, entry.name, 'project.md');
    if (!(await fileExists(projectMd))) continue;
    const content = await readFile(projectMd, 'utf-8');
    const parsed = parseProject(content);
    rows.push({
      slug: parsed.slug || entry.name,
      title: parsed.title || entry.name,
      prefix: parsed.prefix ?? '—',
    });
  }

  rows.sort((a, b) => a.slug.localeCompare(b.slug));
  if (rows.length === 0) {
    console.log('No projects found.');
    return;
  }

  for (const row of rows) {
    console.log(`${row.slug}\t${row.prefix}\t${row.title}`);
  }
}

/** @deprecated Use `projectNewCommand` via `syntaur project new`. */
export async function createProjectCommand(
  title: string,
  options: ProjectNewOptions,
): Promise<string> {
  return projectNewCommand(title, options);
}

export const projectCommand = new Command('project')
  .description('Manage Syntaur projects');

projectCommand
  .command('new')
  .description('Create a new project with all required files')
  .argument('<title>', 'Project title')
  .option('--slug <slug>', 'Override auto-generated slug')
  .option('--prefix <prefix>', 'Override auto-derived ticket id prefix (2–5 uppercase letters)')
  .option('--dir <path>', 'Override default project directory')
  .action(async (title: string, options: ProjectNewOptions) => {
    try {
      await projectNewCommand(title, options);
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

projectCommand
  .command('list')
  .description('List projects with their ticket id prefixes')
  .option('--dir <path>', 'Override default project directory')
  .action(async (options: { dir?: string }) => {
    try {
      await projectListCommand(options.dir);
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });
