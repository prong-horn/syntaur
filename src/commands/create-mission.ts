import { resolve } from 'node:path';
import { slugify, isValidSlug } from '../utils/slug.js';
import { nowTimestamp } from '../utils/timestamp.js';
import { generateId } from '../utils/uuid.js';
import { expandHome } from '../utils/paths.js';
import { ensureDir, writeFileForce, fileExists } from '../utils/fs.js';
import { readConfig } from '../utils/config.js';
import {
  renderManifest,
  renderMission,
  renderAgent,
  renderClaude,
  renderIndexAssignments,
  renderIndexPlans,
  renderIndexDecisions,
  renderIndexSessions,
  renderStatus,
  renderResourcesIndex,
  renderMemoriesIndex,
} from '../templates/index.js';

export interface CreateMissionOptions {
  slug?: string;
  dir?: string;
}

export async function createMissionCommand(
  title: string,
  options: CreateMissionOptions,
): Promise<string> {
  if (!title.trim()) {
    throw new Error('Mission title cannot be empty.');
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
    : config.defaultMissionDir;
  const missionDir = resolve(baseDir, slug);

  if (await fileExists(missionDir)) {
    throw new Error(
      `Mission folder already exists: ${missionDir}\nUse --slug to specify a different slug.`,
    );
  }

  const timestamp = nowTimestamp();
  const id = generateId();

  await ensureDir(resolve(missionDir, 'assignments'));
  await ensureDir(resolve(missionDir, 'resources'));
  await ensureDir(resolve(missionDir, 'memories'));

  const files: Array<[string, string]> = [
    [
      resolve(missionDir, 'manifest.md'),
      renderManifest({ slug, timestamp }),
    ],
    [
      resolve(missionDir, 'mission.md'),
      renderMission({ id, slug, title, timestamp }),
    ],
    [
      resolve(missionDir, 'agent.md'),
      renderAgent({ slug, timestamp }),
    ],
    [
      resolve(missionDir, 'claude.md'),
      renderClaude({ slug }),
    ],
    [
      resolve(missionDir, '_index-assignments.md'),
      renderIndexAssignments({ slug, title, timestamp }),
    ],
    [
      resolve(missionDir, '_index-plans.md'),
      renderIndexPlans({ slug, title, timestamp }),
    ],
    [
      resolve(missionDir, '_index-decisions.md'),
      renderIndexDecisions({ slug, title, timestamp }),
    ],
    [
      resolve(missionDir, '_index-sessions.md'),
      renderIndexSessions({ slug, title, timestamp }),
    ],
    [
      resolve(missionDir, '_status.md'),
      renderStatus({ slug, title, timestamp }),
    ],
    [
      resolve(missionDir, 'resources', '_index.md'),
      renderResourcesIndex({ slug, title, timestamp }),
    ],
    [
      resolve(missionDir, 'memories', '_index.md'),
      renderMemoriesIndex({ slug, title, timestamp }),
    ],
  ];

  for (const [filePath, content] of files) {
    await writeFileForce(filePath, content);
  }

  console.log(`Created mission "${title}" at ${missionDir}/`);
  console.log(`  Slug: ${slug}`);
  console.log(`  Files created:`);
  console.log(`    manifest.md`);
  console.log(`    mission.md`);
  console.log(`    agent.md`);
  console.log(`    claude.md`);
  console.log(`    _index-assignments.md`);
  console.log(`    _index-plans.md`);
  console.log(`    _index-decisions.md`);
  console.log(`    _index-sessions.md`);
  console.log(`    _status.md`);
  console.log(`    resources/_index.md`);
  console.log(`    memories/_index.md`);

  return slug;
}
