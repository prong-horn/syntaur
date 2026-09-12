import { resolve } from 'node:path';
import { slugify, isValidSlug } from '../utils/slug.js';
import { nowTimestamp } from '../utils/timestamp.js';
import { generateId } from '../utils/uuid.js';
import { expandHome } from '../utils/paths.js';
import { ensureDir, writeFileForce, fileExists } from '../utils/fs.js';
import { readConfig } from '../utils/config.js';
import {
  renderManifest,
  renderProject,
  renderIndexAssignments,
  renderIndexPlans,
  renderIndexDecisions,
  renderStatus,
} from '../templates/index.js';

export interface CreateProjectOptions {
  slug?: string;
  dir?: string;
}

export async function createProjectCommand(
  title: string,
  options: CreateProjectOptions,
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

  const timestamp = nowTimestamp();
  const id = generateId();

  await ensureDir(resolve(projectDir, 'tickets'));

  const files: Array<[string, string]> = [
    [
      resolve(projectDir, 'manifest.md'),
      renderManifest({ slug, timestamp }),
    ],
    [
      resolve(projectDir, 'project.md'),
      renderProject({ id, slug, title, timestamp }),
    ],
    [
      resolve(projectDir, '_index-tickets.md'),
      renderIndexAssignments({ slug, title, timestamp }),
    ],
    [
      resolve(projectDir, '_index-plans.md'),
      renderIndexPlans({ slug, title, timestamp }),
    ],
    [
      resolve(projectDir, '_index-decisions.md'),
      renderIndexDecisions({ slug, title, timestamp }),
    ],
    [
      resolve(projectDir, '_status.md'),
      renderStatus({ slug, title, timestamp }),
    ],
  ];

  for (const [filePath, content] of files) {
    await writeFileForce(filePath, content);
  }

  console.log(`Created project "${title}" at ${projectDir}/`);
  console.log(`  Slug: ${slug}`);
  console.log(`  Files created:`);
  console.log(`    manifest.md`);
  console.log(`    project.md`);
  console.log(`    _index-tickets.md`);
  console.log(`    _index-plans.md`);
  console.log(`    _index-decisions.md`);
  console.log(`    _status.md`);

  return slug;
}
