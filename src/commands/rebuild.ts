import { resolve } from 'node:path';
import { readdir } from 'node:fs/promises';
import { expandHome } from '../utils/paths.js';
import { fileExists, writeFileForce } from '../utils/fs.js';
import { readConfig } from '../utils/config.js';
import { nowTimestamp } from '../utils/timestamp.js';
import { scanMission } from '../rebuild/scanner.js';
import { computeStatus } from '../rebuild/status.js';
import {
  renderIndexAssignments,
  renderIndexPlans,
  renderIndexDecisions,
  renderIndexSessions,
  renderStatus,
  renderManifest,
  renderResourcesIndex,
  renderMemoriesIndex,
} from '../rebuild/renderers.js';
import type { RebuildResult } from '../rebuild/types.js';

export interface RebuildOptions {
  mission?: string;
  all?: boolean;
  dir?: string;
}

/**
 * Rebuild all 8 derived files for a single mission.
 */
async function rebuildOneMission(
  missionDir: string,
): Promise<RebuildResult> {
  const data = await scanMission(missionDir);
  const status = computeStatus(data);
  const timestamp = nowTimestamp();

  const files: Array<[string, string]> = [
    [
      resolve(missionDir, 'manifest.md'),
      renderManifest({ slug: data.slug, timestamp }),
    ],
    [
      resolve(missionDir, '_index-assignments.md'),
      renderIndexAssignments({
        slug: data.slug,
        timestamp,
        assignments: data.assignments,
        status,
      }),
    ],
    [
      resolve(missionDir, '_index-plans.md'),
      renderIndexPlans({
        slug: data.slug,
        timestamp,
        assignments: data.assignments,
      }),
    ],
    [
      resolve(missionDir, '_index-decisions.md'),
      renderIndexDecisions({
        slug: data.slug,
        timestamp,
        assignments: data.assignments,
      }),
    ],
    [
      resolve(missionDir, '_index-sessions.md'),
      renderIndexSessions({
        slug: data.slug,
        timestamp,
        assignments: data.assignments,
      }),
    ],
    [
      resolve(missionDir, '_status.md'),
      renderStatus({
        slug: data.slug,
        title: data.title,
        timestamp,
        assignments: data.assignments,
        status,
      }),
    ],
    [
      resolve(missionDir, 'resources', '_index.md'),
      renderResourcesIndex({
        slug: data.slug,
        timestamp,
        resources: data.resources,
      }),
    ],
    [
      resolve(missionDir, 'memories', '_index.md'),
      renderMemoriesIndex({
        slug: data.slug,
        timestamp,
        memories: data.memories,
      }),
    ],
  ];

  for (const [filePath, content] of files) {
    await writeFileForce(filePath, content);
  }

  return {
    missionSlug: data.slug,
    assignmentCount: data.assignments.length,
    filesWritten: files.length,
  };
}

/**
 * CLI command handler for `syntaur rebuild`.
 */
export async function rebuildCommand(
  options: RebuildOptions,
): Promise<void> {
  if (!options.mission && !options.all) {
    throw new Error(
      'Either --mission <slug> or --all is required.',
    );
  }
  if (options.mission && options.all) {
    throw new Error(
      'Cannot use both --mission and --all.',
    );
  }

  const config = await readConfig();
  const baseDir = options.dir
    ? expandHome(options.dir)
    : config.defaultMissionDir;

  if (options.mission) {
    const missionDir = resolve(baseDir, options.mission);
    const missionMdPath = resolve(missionDir, 'mission.md');

    if (
      !(await fileExists(missionDir)) ||
      !(await fileExists(missionMdPath))
    ) {
      throw new Error(
        `Mission "${options.mission}" not found at ${missionDir}.`,
      );
    }

    const result = await rebuildOneMission(missionDir);
    console.log(
      `Rebuilt mission "${result.missionSlug}" (${result.assignmentCount} assignments, ${result.filesWritten} files written)`,
    );
  } else {
    // --all: scan baseDir for mission directories
    if (!(await fileExists(baseDir))) {
      throw new Error(
        `Mission directory not found: ${baseDir}`,
      );
    }

    const entries = await readdir(baseDir, {
      withFileTypes: true,
    });
    const missionDirs = entries.filter((e) => e.isDirectory());

    let totalMissions = 0;
    for (const entry of missionDirs) {
      const missionDir = resolve(baseDir, entry.name);
      const missionMdPath = resolve(missionDir, 'mission.md');

      if (!(await fileExists(missionMdPath))) continue;

      const result = await rebuildOneMission(missionDir);
      console.log(
        `  Rebuilt "${result.missionSlug}" (${result.assignmentCount} assignments)`,
      );
      totalMissions++;
    }

    console.log(
      `\nRebuilt ${totalMissions} mission${totalMissions !== 1 ? 's' : ''}.`,
    );
  }
}
