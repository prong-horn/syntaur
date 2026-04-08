import { resolve } from 'node:path';
import { slugify, isValidSlug } from '../utils/slug.js';
import { nowTimestamp } from '../utils/timestamp.js';
import { playbooksDir as getPlaybooksDir } from '../utils/paths.js';
import { ensureDir, writeFileSafe, fileExists } from '../utils/fs.js';
import { renderPlaybook } from '../templates/playbook.js';
import { rebuildPlaybookManifest } from '../utils/playbooks.js';

export interface CreatePlaybookOptions {
  slug?: string;
  description?: string;
}

export async function createPlaybookCommand(
  name: string,
  options: CreatePlaybookOptions,
): Promise<string> {
  if (!name.trim()) {
    throw new Error('Playbook name cannot be empty.');
  }

  const slug = options.slug || slugify(name);
  if (!isValidSlug(slug)) {
    throw new Error(
      `Invalid slug "${slug}". Slugs must be lowercase, hyphen-separated, with no special characters.`,
    );
  }

  const dir = getPlaybooksDir();
  await ensureDir(dir);

  const filePath = resolve(dir, `${slug}.md`);
  if (await fileExists(filePath)) {
    throw new Error(
      `Playbook "${slug}" already exists at ${filePath}\nUse --slug to specify a different slug.`,
    );
  }

  const timestamp = nowTimestamp();
  const description = options.description || '';

  const content = renderPlaybook({ slug, name, description, timestamp });
  await writeFileSafe(filePath, content);
  await rebuildPlaybookManifest(dir);

  console.log(`Created playbook "${name}" at ${filePath}`);
  console.log(`  Slug: ${slug}`);

  return slug;
}
