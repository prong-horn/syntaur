import { Command } from 'commander';
import { resolve } from 'node:path';
import { readFile, readdir, rm } from 'node:fs/promises';
import { readConfig } from '../utils/config.js';
import { fileExists, writeFileForce } from '../utils/fs.js';
import { isValidSlug, slugify } from '../utils/slug.js';
import { rebuildResourcesIndex } from '../utils/project-indexes.js';
import { parseResource } from '../dashboard/parser.js';

interface ResourceAddOptions {
  project: string;
  name: string;
  source: string;
  category?: string;
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

function setScalarField(fm: string, key: string, value: string | null): string {
  const formatted = value === null ? 'null' : yamlQuote(value);
  const re = new RegExp(`^${key}:[^\\n]*$`, 'm');
  return re.test(fm) ? fm.replace(re, `${key}: ${formatted}`) : `${fm}\n${key}: ${formatted}`;
}

function setListField(fm: string, key: string, items: string[]): string {
  const serialized =
    items.length === 0 ? `${key}: []` : `${key}:\n${items.map((i) => `  - ${i}`).join('\n')}`;
  // Match the `key:` line plus any following indented `- ` list items.
  const re = new RegExp(`^${key}:[^\\n]*(?:\\n[ \\t]+-[^\\n]*)*$`, 'm');
  return re.test(fm) ? fm.replace(re, serialized) : `${fm}\n${serialized}`;
}

/**
 * Edit only the given frontmatter fields in place (preserving the body and any
 * unknown frontmatter the dashboard may have written), and bump `updated`. This
 * is used by `update` instead of a full re-render so nothing is lost.
 */
function editResourceFrontmatter(
  content: string,
  updates: { name?: string; category?: string; source?: string; relatedAssignments?: string[] },
): string {
  const m = content.match(/^(---\n)([\s\S]*?)(\n---)([\s\S]*)$/);
  if (!m) throw new Error('Resource file has no frontmatter.');
  let fm = m[2];
  if (updates.name !== undefined) fm = setScalarField(fm, 'name', updates.name);
  if (updates.category !== undefined) fm = setScalarField(fm, 'category', updates.category);
  if (updates.source !== undefined) fm = setScalarField(fm, 'source', updates.source);
  if (updates.relatedAssignments !== undefined) {
    fm = setListField(fm, 'relatedAssignments', updates.relatedAssignments);
  }
  fm = setScalarField(fm, 'updated', nowIso());
  return `${m[1]}${fm}${m[3]}${m[4]}`;
}

function renderResourceFile(opts: {
  name: string;
  source: string;
  category: string;
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
  return `---
name: ${yamlQuote(opts.name)}
category: ${yamlQuote(opts.category)}
source: ${yamlQuote(opts.source)}
relatedAssignments:${related}
created: "${created}"
updated: "${updated}"
---

# ${opts.name}

${opts.body ?? '<!-- Add notes about this resource here. -->'}
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

export async function runResourceAdd(
  options: ResourceAddOptions,
): Promise<{ filePath: string; indexPath: string; total: number }> {
  const projectDir = await resolveProjectDir(options.project);
  if (!options.name) throw new Error('--name is required.');
  if (!options.source) throw new Error('--source is required.');

  const slug = options.slug ?? slugify(options.name);
  if (!isValidSlug(slug)) {
    throw new Error(`Invalid resource slug: "${slug}".`);
  }
  const filePath = resolve(projectDir, 'resources', `${slug}.md`);
  if ((await fileExists(filePath)) && !options.force) {
    throw new Error(
      `Resource "${slug}" already exists at ${filePath}. Use --force to overwrite.`,
    );
  }
  const content = renderResourceFile({
    name: options.name,
    source: options.source,
    category: options.category ?? '',
    relatedAssignments: parseList(options.relatedAssignments),
  });
  await writeFileForce(filePath, content);
  const { path: indexPath, total } = await rebuildResourcesIndex(projectDir);
  return { filePath, indexPath, total };
}

export interface ResourceSummary {
  slug: string;
  name: string;
  category: string;
  source: string;
  updated: string;
}

async function listResourceSlugs(projectDir: string): Promise<string[]> {
  const dir = resolve(projectDir, 'resources');
  if (!(await fileExists(dir))) return [];
  const entries = await readdir(dir, { withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && e.name.endsWith('.md') && e.name !== '_index.md')
    .map((e) => e.name.slice(0, -3))
    .sort();
}

export async function runResourceList(project: string): Promise<ResourceSummary[]> {
  const projectDir = await resolveProjectDir(project);
  const slugs = await listResourceSlugs(projectDir);
  const out: ResourceSummary[] = [];
  for (const slug of slugs) {
    const parsed = parseResource(await readFile(resolve(projectDir, 'resources', `${slug}.md`), 'utf-8'));
    out.push({ slug, name: parsed.name, category: parsed.category, source: parsed.source, updated: parsed.updated });
  }
  return out;
}

export async function runResourceShow(
  project: string,
  slug: string,
): Promise<ResourceSummary & { relatedAssignments: string[]; created: string; body: string }> {
  const projectDir = await resolveProjectDir(project);
  const filePath = resolve(projectDir, 'resources', `${slug}.md`);
  if (!(await fileExists(filePath))) throw new Error(`Resource "${slug}" not found in project "${project}".`);
  const parsed = parseResource(await readFile(filePath, 'utf-8'));
  return {
    slug,
    name: parsed.name,
    category: parsed.category,
    source: parsed.source,
    updated: parsed.updated,
    created: parsed.created,
    relatedAssignments: parsed.relatedAssignments,
    body: parsed.body,
  };
}

export interface ResourceUpdateOptions {
  project: string;
  name?: string;
  source?: string;
  category?: string;
  relatedAssignments?: string;
}

export async function runResourceUpdate(
  slug: string,
  options: ResourceUpdateOptions,
): Promise<{ filePath: string; indexPath: string; total: number }> {
  const projectDir = await resolveProjectDir(options.project);
  const filePath = resolve(projectDir, 'resources', `${slug}.md`);
  if (!(await fileExists(filePath))) {
    throw new Error(`Resource "${slug}" not found in project "${options.project}".`);
  }
  if (
    options.name === undefined &&
    options.source === undefined &&
    options.category === undefined &&
    options.relatedAssignments === undefined
  ) {
    throw new Error('Provide at least one of --name, --source, --category, --related-assignments.');
  }
  const original = await readFile(filePath, 'utf-8');
  const content = editResourceFrontmatter(original, {
    name: options.name,
    category: options.category,
    source: options.source,
    relatedAssignments:
      options.relatedAssignments !== undefined ? parseList(options.relatedAssignments) : undefined,
  });
  await writeFileForce(filePath, content);
  const { path: indexPath, total } = await rebuildResourcesIndex(projectDir);
  return { filePath, indexPath, total };
}

export async function runResourceRemove(
  slug: string,
  options: { project: string; force?: boolean },
): Promise<{ filePath: string; indexPath: string; total: number }> {
  const projectDir = await resolveProjectDir(options.project);
  const filePath = resolve(projectDir, 'resources', `${slug}.md`);
  if (!(await fileExists(filePath))) {
    throw new Error(`Resource "${slug}" not found in project "${options.project}".`);
  }
  await rm(filePath);
  const { path: indexPath, total } = await rebuildResourcesIndex(projectDir);
  return { filePath, indexPath, total };
}

export const resourceCommand = new Command('resource')
  .description('Manage project-level resource entries');

resourceCommand
  .command('add')
  .description(
    'Add a project resource at <projectDir>/resources/<slug>.md and regenerate _index.md',
  )
  .requiredOption('--project <slug>', 'Project slug')
  .requiredOption('--name <name>', 'Human-readable resource name')
  .requiredOption('--source <url-or-path>', 'Resource source (URL or path)')
  .option('--category <name>', 'Optional category (e.g. dashboard, doc, ticket)')
  .option('--slug <slug>', 'Override the slug (default: slugify(--name))')
  .option('--related-assignments <slugs>', 'Comma-separated related assignment slugs')
  .option('--force', 'Overwrite if the resource file already exists')
  .action(async (options: ResourceAddOptions) => {
    try {
      const { filePath, indexPath, total } = await runResourceAdd(options);
      console.log(`Wrote ${filePath}`);
      console.log(`Rebuilt ${indexPath} (${total} total resources).`);
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

resourceCommand
  .command('list')
  .description('List a project\'s resources')
  .requiredOption('--project <slug>', 'Project slug')
  .option('--json', 'Output as JSON')
  .action(async (options: { project: string; json?: boolean }) => {
    try {
      const rows = await runResourceList(options.project);
      if (options.json) {
        console.log(JSON.stringify(rows, null, 2));
      } else if (rows.length === 0) {
        console.log('No resources.');
      } else {
        for (const r of rows) {
          console.log(`${r.slug}  —  ${r.name}${r.category ? ` [${r.category}]` : ''}  ${r.source}`);
        }
      }
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

resourceCommand
  .command('show')
  .description('Show one resource by slug')
  .argument('<slug>', 'Resource slug')
  .requiredOption('--project <slug>', 'Project slug')
  .option('--json', 'Output as JSON')
  .action(async (slug: string, options: { project: string; json?: boolean }) => {
    try {
      const r = await runResourceShow(options.project, slug);
      if (options.json) {
        console.log(JSON.stringify(r, null, 2));
      } else {
        console.log(`slug:     ${r.slug}`);
        console.log(`name:     ${r.name}`);
        console.log(`category: ${r.category}`);
        console.log(`source:   ${r.source}`);
        console.log(`created:  ${r.created}`);
        console.log(`updated:  ${r.updated}`);
        console.log(`related:  ${r.relatedAssignments.join(', ') || '(none)'}`);
      }
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

resourceCommand
  .command('update')
  .description('Update fields on an existing resource and regenerate _index.md')
  .argument('<slug>', 'Resource slug')
  .requiredOption('--project <slug>', 'Project slug')
  .option('--name <name>', 'New name')
  .option('--source <url-or-path>', 'New source')
  .option('--category <name>', 'New category')
  .option('--related-assignments <slugs>', 'Comma-separated related assignment slugs (replaces the list)')
  .action(async (slug: string, options: ResourceUpdateOptions) => {
    try {
      const { filePath, indexPath, total } = await runResourceUpdate(slug, options);
      console.log(`Updated ${filePath}`);
      console.log(`Rebuilt ${indexPath} (${total} total resources).`);
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

resourceCommand
  .command('remove')
  .description('Remove a resource and regenerate _index.md')
  .argument('<slug>', 'Resource slug')
  .requiredOption('--project <slug>', 'Project slug')
  .option('--force', 'Remove without prompting')
  .action(async (slug: string, options: { project: string; force?: boolean }) => {
    try {
      const { filePath, indexPath, total } = await runResourceRemove(slug, options);
      console.log(`Removed ${filePath}`);
      console.log(`Rebuilt ${indexPath} (${total} total resources).`);
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });
