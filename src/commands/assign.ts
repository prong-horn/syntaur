import { resolve } from 'node:path';
import { expandHome } from '../utils/paths.js';
import { fileExists } from '../utils/fs.js';
import { readConfig } from '../utils/config.js';
import { isValidSlug } from '../utils/slug.js';
import { executeAssign } from '../lifecycle/index.js';

export interface AssignOptions {
  project: string;
  agent: string;
  dir?: string;
}

export async function assignCommand(
  assignment: string,
  options: AssignOptions,
): Promise<void> {
  if (!options.project) {
    throw new Error('--project <slug> is required.');
  }
  if (!isValidSlug(options.project)) {
    throw new Error(
      `Invalid project slug "${options.project}". Slugs must be lowercase, hyphen-separated, with no special characters.`,
    );
  }
  if (!options.agent) {
    throw new Error('--agent <name> is required.');
  }
  if (!isValidSlug(assignment)) {
    throw new Error(
      `Invalid assignment slug "${assignment}". Slugs must be lowercase, hyphen-separated, with no special characters.`,
    );
  }

  const config = await readConfig();
  const baseDir = options.dir
    ? expandHome(options.dir)
    : config.defaultProjectDir;
  const projectDir = resolve(baseDir, options.project);

  const projectMdPath = resolve(projectDir, 'project.md');
  if (!(await fileExists(projectDir)) || !(await fileExists(projectMdPath))) {
    throw new Error(
      `Project "${options.project}" not found at ${projectDir}.`,
    );
  }

  const result = await executeAssign(projectDir, assignment, options.agent);

  if (!result.success) {
    throw new Error(result.message);
  }

  console.log(result.message);
}
