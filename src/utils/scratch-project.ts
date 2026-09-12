import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { readConfig } from './config.js';
import { expandHome } from './paths.js';
import { fileExists } from './fs.js';
import { projectNewCommand } from '../commands/project.js';
import { parseProject } from '../dashboard/parser.js';
import { writeProjectScaffold } from './project-scaffold.js';

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
  } else {
    const parsed = parseProject(await readFile(projectMd, 'utf-8'));
    await writeProjectScaffold(
      projectDir,
      {
        slug: SCRATCH_PROJECT_SLUG,
        title: parsed.title || 'Scratch',
        prefix: parsed.prefix ?? 'SCR',
        nextTicket: parsed.nextTicket ?? 1,
      },
      { onlyMissing: true },
    );
  }
  return SCRATCH_PROJECT_SLUG;
}
