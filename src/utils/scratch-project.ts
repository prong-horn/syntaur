import { resolve } from 'node:path';
import { readConfig } from './config.js';
import { expandHome } from './paths.js';
import { fileExists } from './fs.js';
import { projectNewCommand } from '../commands/project.js';

export const SCRATCH_PROJECT_SLUG = 'scratch';

/** Ensure the lazy scratch project exists (prefix SCR) and return its slug. */
export async function ensureScratchProject(dir?: string): Promise<string> {
  const config = await readConfig();
  const baseDir = dir ? expandHome(dir) : config.defaultProjectDir;
  const projectDir = resolve(baseDir, SCRATCH_PROJECT_SLUG);
  const projectMd = resolve(projectDir, 'project.md');
  if (!(await fileExists(projectMd))) {
    await projectNewCommand('Scratch', {
      slug: SCRATCH_PROJECT_SLUG,
      prefix: 'SCR',
      dir: baseDir,
      silent: true,
    });
  }
  return SCRATCH_PROJECT_SLUG;
}
