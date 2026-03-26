import { resolve } from 'node:path';
import { expandHome } from '../utils/paths.js';
import { fileExists } from '../utils/fs.js';
import { readConfig } from '../utils/config.js';
import { isValidSlug } from '../utils/slug.js';
import { executeTransition } from '../lifecycle/index.js';

export interface CompleteOptions {
  mission: string;
  dir?: string;
}

export async function completeCommand(
  assignment: string,
  options: CompleteOptions,
): Promise<void> {
  if (!options.mission) {
    throw new Error('--mission <slug> is required.');
  }
  if (!isValidSlug(options.mission)) {
    throw new Error(
      `Invalid mission slug "${options.mission}". Slugs must be lowercase, hyphen-separated, with no special characters.`,
    );
  }
  if (!isValidSlug(assignment)) {
    throw new Error(
      `Invalid assignment slug "${assignment}". Slugs must be lowercase, hyphen-separated, with no special characters.`,
    );
  }

  const config = await readConfig();
  const baseDir = options.dir
    ? expandHome(options.dir)
    : config.defaultMissionDir;
  const missionDir = resolve(baseDir, options.mission);

  const missionMdPath = resolve(missionDir, 'mission.md');
  if (!(await fileExists(missionDir)) || !(await fileExists(missionMdPath))) {
    throw new Error(
      `Mission "${options.mission}" not found at ${missionDir}.`,
    );
  }

  const result = await executeTransition(missionDir, assignment, 'complete');

  if (!result.success) {
    throw new Error(result.message);
  }

  console.log(result.message);
}
