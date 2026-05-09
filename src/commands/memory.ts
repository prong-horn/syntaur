import { Command } from 'commander';
import { resolve } from 'node:path';
import { defaultProjectDir } from '../utils/paths.js';
import { fileExists, writeFileForce } from '../utils/fs.js';
import { isValidSlug, slugify } from '../utils/slug.js';
import { rebuildMemoriesIndex } from '../utils/project-indexes.js';

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

function renderMemoryFile(opts: {
  name: string;
  source: string;
  scope: string;
  sourceAssignment: string | null;
  relatedAssignments: string[];
  body?: string;
}): string {
  const created = nowIso();
  const related =
    opts.relatedAssignments.length === 0
      ? '[]'
      : `\n${opts.relatedAssignments.map((a) => `  - ${a}`).join('\n')}`;
  const sourceAssignment =
    opts.sourceAssignment === null ? 'null' : `"${opts.sourceAssignment.replace(/"/g, '\\"')}"`;
  return `---
name: "${opts.name.replace(/"/g, '\\"')}"
source: "${opts.source}"
scope: "${opts.scope}"
sourceAssignment: ${sourceAssignment}
relatedAssignments:${related}
created: "${created}"
updated: "${created}"
---

# ${opts.name}

${opts.body ?? '<!-- Capture the load-bearing context for this memory here. -->'}
`;
}

export async function runMemoryAdd(
  options: MemoryAddOptions,
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
