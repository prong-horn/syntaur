import { isValidSlug } from '../utils/slug.js';
import { playbooksDir as getPlaybooksDir } from '../utils/paths.js';
import { setPlaybookEnabled } from '../utils/playbooks.js';

export async function enablePlaybookCommand(slug: string): Promise<void> {
  if (!slug.trim()) {
    throw new Error('Playbook slug cannot be empty.');
  }
  if (!isValidSlug(slug)) {
    throw new Error(
      `Invalid slug "${slug}". Slugs must be lowercase, hyphen-separated, with no special characters.`,
    );
  }

  const dir = getPlaybooksDir();
  const { slug: canonical, changed } = await setPlaybookEnabled(dir, slug, true);

  if (changed) {
    console.log(`Playbook "${canonical}" enabled.`);
  } else {
    console.log(`Playbook "${canonical}" is already enabled.`);
  }
}
