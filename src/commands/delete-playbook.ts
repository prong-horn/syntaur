import { isValidSlug } from '../utils/slug.js';
import { playbooksDir as getPlaybooksDir } from '../utils/paths.js';
import { deletePlaybook, PlaybookError } from '../utils/playbooks.js';

export async function deletePlaybookCommand(slug: string): Promise<void> {
  if (!slug.trim()) {
    throw new Error('Playbook slug cannot be empty.');
  }
  if (!isValidSlug(slug)) {
    throw new Error(
      `Invalid slug "${slug}". Slugs must be lowercase, hyphen-separated, with no special characters.`,
    );
  }

  const dir = getPlaybooksDir();
  try {
    const { slug: canonical } = await deletePlaybook(dir, slug);
    console.log(`Playbook "${canonical}" deleted.`);
  } catch (error) {
    if (error instanceof PlaybookError) {
      // Rethrow with a stable message so the CLI harness reports it consistently
      // with sibling commands like enable/disable.
      throw new Error(error.message);
    }
    throw error;
  }
}
