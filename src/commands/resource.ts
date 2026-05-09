import { Command } from 'commander';
import { resolve } from 'node:path';
import { defaultProjectDir } from '../utils/paths.js';
import { fileExists, writeFileForce } from '../utils/fs.js';
import { isValidSlug, slugify } from '../utils/slug.js';
import { rebuildResourcesIndex } from '../utils/project-indexes.js';

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

function renderResourceFile(opts: {
  name: string;
  source: string;
  category: string;
  relatedAssignments: string[];
  body?: string;
}): string {
  const created = nowIso();
  const related =
    opts.relatedAssignments.length === 0
      ? '[]'
      : `\n${opts.relatedAssignments.map((a) => `  - ${a}`).join('\n')}`;
  return `---
name: "${opts.name.replace(/"/g, '\\"')}"
category: "${opts.category}"
source: "${opts.source}"
relatedAssignments:${related}
created: "${created}"
updated: "${created}"
---

# ${opts.name}

${opts.body ?? '<!-- Add notes about this resource here. -->'}
`;
}

export async function runResourceAdd(
  options: ResourceAddOptions,
): Promise<{ filePath: string; indexPath: string; total: number }> {
  if (!isValidSlug(options.project)) {
    throw new Error(`Invalid project slug: "${options.project}".`);
  }
  const projectDir = resolve(defaultProjectDir(), options.project);
  if (!(await fileExists(resolve(projectDir, 'project.md')))) {
    throw new Error(`Project "${options.project}" not found at ${projectDir}.`);
  }
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
