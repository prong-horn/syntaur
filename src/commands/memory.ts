import { Command } from 'commander';
import { resolve } from 'node:path';
import { readFile, readdir, rm } from 'node:fs/promises';
import { readConfig } from '../utils/config.js';
import { fileExists, writeFileForce } from '../utils/fs.js';
import { isValidSlug, slugify } from '../utils/slug.js';
import { rebuildMemoriesIndex } from '../utils/project-indexes.js';
import { parseMemory } from '../dashboard/parser.js';

interface MemoryAddOptions {
  project: string;
  name: string;
  source: string;
  scope?: string;
  sourceAssignment?: string;
  slug?: string;
  relatedAssignments?: string;
  force?: boolean;
}

function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function parseList(value?: string): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
}

function yamlQuote(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * `parseMemory().body` includes the leading `# <name>` H1. Strip it so a
 * re-render (which re-adds the heading) doesn't stack duplicate headings on
 * every update.
 */
function stripLeadingHeading(body: string): string {
  return body.replace(/^\s*#\s+.*\r?\n+/, '').trim();
}

function renderMemoryFile(opts: {
  name: string;
  source: string;
  scope: string;
  sourceAssignment: string | null;
  relatedAssignments: string[];
  body?: string;
  created?: string;
  updated?: string;
}): string {
  const created = opts.created ?? nowIso();
  const updated = opts.updated ?? created;
  const related =
    opts.relatedAssignments.length === 0
      ? '[]'
      : `\n${opts.relatedAssignments.map((a) => `  - ${a}`).join('\n')}`;
  const sourceAssignment =
    opts.sourceAssignment === null ? 'null' : yamlQuote(opts.sourceAssignment);
  return `---
name: ${yamlQuote(opts.name)}
source: ${yamlQuote(opts.source)}
scope: ${yamlQuote(opts.scope)}
sourceAssignment: ${sourceAssignment}
relatedAssignments:${related}
created: "${created}"
updated: "${updated}"
---

# ${opts.name}

${opts.body ?? '<!-- Capture the load-bearing context for this memory here. -->'}
`;
}

async function resolveProjectDir(project: string): Promise<string> {
  if (!isValidSlug(project)) throw new Error(`Invalid project slug: "${project}".`);
  const projectDir = resolve((await readConfig()).defaultProjectDir, project);
  if (!(await fileExists(resolve(projectDir, 'project.md')))) {
    throw new Error(`Project "${project}" not found at ${projectDir}.`);
  }
  return projectDir;
}

export async function runMemoryAdd(
  options: MemoryAddOptions,
): Promise<{ filePath: string; indexPath: string; total: number }> {
  const projectDir = await resolveProjectDir(options.project);
  if (!options.name) throw new Error('--name is required.');
  if (!options.source) throw new Error('--source is required.');

  const slug = options.slug ?? slugify(options.name);
  if (!isValidSlug(slug)) {
    throw new Error(`Invalid memory slug: "${slug}".`);
  }
  const filePath = resolve(projectDir, 'memories', `${slug}.md`);
  if ((await fileExists(filePath)) && !options.force) {
    throw new Error(
      `Memory "${slug}" already exists at ${filePath}. Use --force to overwrite.`,
    );
  }
  const content = renderMemoryFile({
    name: options.name,
    source: options.source,
    scope: options.scope ?? 'project',
    sourceAssignment: options.sourceAssignment ?? null,
    relatedAssignments: parseList(options.relatedAssignments),
  });
  await writeFileForce(filePath, content);
  const { path: indexPath, total } = await rebuildMemoriesIndex(projectDir);
  return { filePath, indexPath, total };
}

export interface MemorySummary {
  slug: string;
  name: string;
  scope: string;
  source: string;
  updated: string;
}

async function listMemorySlugs(projectDir: string): Promise<string[]> {
  const dir = resolve(projectDir, 'memories');
  if (!(await fileExists(dir))) return [];
  const entries = await readdir(dir, { withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && e.name.endsWith('.md') && e.name !== '_index.md')
    .map((e) => e.name.slice(0, -3))
    .sort();
}

export async function runMemoryList(project: string): Promise<MemorySummary[]> {
  const projectDir = await resolveProjectDir(project);
  const slugs = await listMemorySlugs(projectDir);
  const out: MemorySummary[] = [];
  for (const slug of slugs) {
    const parsed = parseMemory(await readFile(resolve(projectDir, 'memories', `${slug}.md`), 'utf-8'));
    out.push({ slug, name: parsed.name, scope: parsed.scope, source: parsed.source, updated: parsed.updated });
  }
  return out;
}

export async function runMemoryShow(
  project: string,
  slug: string,
): Promise<
  MemorySummary & {
    sourceAssignment: string | null;
    relatedAssignments: string[];
    created: string;
    body: string;
  }
> {
  const projectDir = await resolveProjectDir(project);
  const filePath = resolve(projectDir, 'memories', `${slug}.md`);
  if (!(await fileExists(filePath))) throw new Error(`Memory "${slug}" not found in project "${project}".`);
  const parsed = parseMemory(await readFile(filePath, 'utf-8'));
  return {
    slug,
    name: parsed.name,
    scope: parsed.scope,
    source: parsed.source,
    updated: parsed.updated,
    created: parsed.created,
    sourceAssignment: parsed.sourceAssignment,
    relatedAssignments: parsed.relatedAssignments,
    body: parsed.body,
  };
}

export interface MemoryUpdateOptions {
  project: string;
  name?: string;
  source?: string;
  scope?: string;
  sourceAssignment?: string;
  relatedAssignments?: string;
}

export async function runMemoryUpdate(
  slug: string,
  options: MemoryUpdateOptions,
): Promise<{ filePath: string; indexPath: string; total: number }> {
  const projectDir = await resolveProjectDir(options.project);
  const filePath = resolve(projectDir, 'memories', `${slug}.md`);
  if (!(await fileExists(filePath))) {
    throw new Error(`Memory "${slug}" not found in project "${options.project}".`);
  }
  const existing = parseMemory(await readFile(filePath, 'utf-8'));
  if (
    options.name === undefined &&
    options.source === undefined &&
    options.scope === undefined &&
    options.sourceAssignment === undefined &&
    options.relatedAssignments === undefined
  ) {
    throw new Error(
      'Provide at least one of --name, --source, --scope, --source-assignment, --related-assignments.',
    );
  }
  const content = renderMemoryFile({
    name: options.name ?? existing.name,
    source: options.source ?? existing.source,
    scope: options.scope ?? existing.scope,
    sourceAssignment:
      options.sourceAssignment !== undefined ? options.sourceAssignment : existing.sourceAssignment,
    relatedAssignments:
      options.relatedAssignments !== undefined
        ? parseList(options.relatedAssignments)
        : existing.relatedAssignments,
    body: stripLeadingHeading(existing.body) || undefined,
    created: existing.created || undefined,
    updated: nowIso(),
  });
  await writeFileForce(filePath, content);
  const { path: indexPath, total } = await rebuildMemoriesIndex(projectDir);
  return { filePath, indexPath, total };
}

export async function runMemoryRemove(
  slug: string,
  options: { project: string; force?: boolean },
): Promise<{ filePath: string; indexPath: string; total: number }> {
  const projectDir = await resolveProjectDir(options.project);
  const filePath = resolve(projectDir, 'memories', `${slug}.md`);
  if (!(await fileExists(filePath))) {
    throw new Error(`Memory "${slug}" not found in project "${options.project}".`);
  }
  await rm(filePath);
  const { path: indexPath, total } = await rebuildMemoriesIndex(projectDir);
  return { filePath, indexPath, total };
}

export const memoryCommand = new Command('memory')
  .description('Manage project-level memory entries');

memoryCommand
  .command('add')
  .description(
    'Add a project memory at <projectDir>/memories/<slug>.md and regenerate _index.md',
  )
  .requiredOption('--project <slug>', 'Project slug')
  .requiredOption('--name <name>', 'Human-readable memory name')
  .requiredOption('--source <text>', 'Where this memory came from (conversation, decision, doc URL, etc.)')
  .option('--scope <scope>', 'Memory scope (default: project)', 'project')
  .option('--source-assignment <slug>', 'Assignment slug this memory was captured during')
  .option('--slug <slug>', 'Override the slug (default: slugify(--name))')
  .option('--related-assignments <slugs>', 'Comma-separated related assignment slugs')
  .option('--force', 'Overwrite if the memory file already exists')
  .action(async (options: MemoryAddOptions) => {
    try {
      const { filePath, indexPath, total } = await runMemoryAdd(options);
      console.log(`Wrote ${filePath}`);
      console.log(`Rebuilt ${indexPath} (${total} total memories).`);
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

memoryCommand
  .command('list')
  .description("List a project's memories")
  .requiredOption('--project <slug>', 'Project slug')
  .option('--json', 'Output as JSON')
  .action(async (options: { project: string; json?: boolean }) => {
    try {
      const rows = await runMemoryList(options.project);
      if (options.json) {
        console.log(JSON.stringify(rows, null, 2));
      } else if (rows.length === 0) {
        console.log('No memories.');
      } else {
        for (const m of rows) {
          console.log(`${m.slug}  —  ${m.name}${m.scope ? ` [${m.scope}]` : ''}  ${m.source}`);
        }
      }
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

memoryCommand
  .command('show')
  .description('Show one memory by slug')
  .argument('<slug>', 'Memory slug')
  .requiredOption('--project <slug>', 'Project slug')
  .option('--json', 'Output as JSON')
  .action(async (slug: string, options: { project: string; json?: boolean }) => {
    try {
      const m = await runMemoryShow(options.project, slug);
      if (options.json) {
        console.log(JSON.stringify(m, null, 2));
      } else {
        console.log(`slug:             ${m.slug}`);
        console.log(`name:             ${m.name}`);
        console.log(`scope:            ${m.scope}`);
        console.log(`source:           ${m.source}`);
        console.log(`sourceAssignment: ${m.sourceAssignment ?? '(none)'}`);
        console.log(`created:          ${m.created}`);
        console.log(`updated:          ${m.updated}`);
        console.log(`related:          ${m.relatedAssignments.join(', ') || '(none)'}`);
      }
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

memoryCommand
  .command('update')
  .description('Update fields on an existing memory and regenerate _index.md')
  .argument('<slug>', 'Memory slug')
  .requiredOption('--project <slug>', 'Project slug')
  .option('--name <name>', 'New name')
  .option('--source <text>', 'New source')
  .option('--scope <scope>', 'New scope')
  .option('--source-assignment <slug>', 'New source assignment slug')
  .option('--related-assignments <slugs>', 'Comma-separated related assignment slugs (replaces the list)')
  .action(async (slug: string, options: MemoryUpdateOptions) => {
    try {
      const { filePath, indexPath, total } = await runMemoryUpdate(slug, options);
      console.log(`Updated ${filePath}`);
      console.log(`Rebuilt ${indexPath} (${total} total memories).`);
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

memoryCommand
  .command('remove')
  .description('Remove a memory and regenerate _index.md')
  .argument('<slug>', 'Memory slug')
  .requiredOption('--project <slug>', 'Project slug')
  .option('--force', 'Remove without prompting')
  .action(async (slug: string, options: { project: string; force?: boolean }) => {
    try {
      const { filePath, indexPath, total } = await runMemoryRemove(slug, options);
      console.log(`Removed ${filePath}`);
      console.log(`Rebuilt ${indexPath} (${total} total memories).`);
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });
