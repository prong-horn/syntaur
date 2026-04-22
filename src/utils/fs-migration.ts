import { readdir, readFile, rename, writeFile } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { resolve } from 'node:path';
import { fileExists } from './fs.js';

/**
 * Filesystem-level migrations for users upgrading from pre-v0.2.0 installs,
 * where the product used "mission" terminology. v0.2.0 renamed code but
 * shipped no on-disk migration, leaving user state unreadable by the new
 * scanner. These helpers close that gap.
 *
 * All helpers are idempotent, safe on missing paths, and NEVER delete user
 * files. Legacy files that are no longer read (e.g., per-project agent.md,
 * claude.md) are left untouched.
 */

export interface ProjectFilesMigrationResult {
  /** Relative paths of files that were renamed (e.g. `ai-chat-v2/mission.md`). */
  renamedProjectFiles: string[];
  /** Project slugs that still have stale agent.md / claude.md files. Reported, not deleted. */
  legacyExtras: string[];
}

export interface ConfigMigrationResult {
  /** True if `defaultMissionDir` was renamed to `defaultProjectDir`. */
  renamedField: boolean;
  /** True if the on-disk `<root>/missions` dir was renamed to `<root>/projects`. */
  renamedDir: boolean;
  /** The resolved projects dir after migration (absolute, or null if config absent). */
  resolvedProjectsDir: string | null;
}

/**
 * Walk each project directory under `projectsDir` and rename
 * `mission.md` → `project.md` when the legacy file is present and the new
 * name isn't. Reports stale per-project `agent.md` / `claude.md` files
 * without touching them.
 *
 * Swallows per-entry errors (e.g., EPERM on a single dir) so one bad
 * project can't block the rest. Never throws.
 */
export async function migrateLegacyProjectFiles(
  projectsDir: string,
): Promise<ProjectFilesMigrationResult> {
  const result: ProjectFilesMigrationResult = {
    renamedProjectFiles: [],
    legacyExtras: [],
  };

  if (!(await fileExists(projectsDir))) return result;

  let entries: Dirent[];
  try {
    entries = (await readdir(projectsDir, { withFileTypes: true })) as Dirent[];
  } catch {
    return result;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;

    const projectDir = resolve(projectsDir, entry.name);
    const legacy = resolve(projectDir, 'mission.md');
    const target = resolve(projectDir, 'project.md');

    try {
      if ((await fileExists(legacy)) && !(await fileExists(target))) {
        await rename(legacy, target);
        result.renamedProjectFiles.push(`${entry.name}/mission.md`);
      }
    } catch {
      // Swallow per-project errors (permission denied, racing editor, etc).
      continue;
    }

    // Surface stale legacy files without deleting them — caller decides how
    // to present (log once at startup).
    for (const stale of ['agent.md', 'claude.md']) {
      try {
        if (await fileExists(resolve(projectDir, stale))) {
          result.legacyExtras.push(`${entry.name}/${stale}`);
        }
      } catch {
        // Ignore.
      }
    }
  }

  return result;
}

/**
 * Migrate ~/.syntaur/config.md frontmatter and, optionally, the on-disk
 * projects directory, from the pre-v0.2.0 "mission" layout.
 *
 * - Renames `defaultMissionDir` → `defaultProjectDir` in frontmatter when
 *   the new key isn't already present.
 * - If the resolved projects dir ends in `/missions` AND that dir exists
 *   AND its `/projects` sibling does not, renames the directory on disk
 *   and updates the config to point at the new path.
 *
 * Only rewrites the config file when an actual change is made.
 */
export async function migrateLegacyConfig(
  configPath: string,
): Promise<ConfigMigrationResult> {
  const result: ConfigMigrationResult = {
    renamedField: false,
    renamedDir: false,
    resolvedProjectsDir: null,
  };

  if (!(await fileExists(configPath))) return result;

  let content: string;
  try {
    content = await readFile(configPath, 'utf-8');
  } catch {
    return result;
  }

  const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!fmMatch) return result;

  const fmBlock = fmMatch[1];
  const afterFm = content.slice(fmMatch[0].length);

  // --- Field rename ---
  const missionLineRe = /^(\s*)defaultMissionDir\s*:\s*(.*)$/m;
  const missionLineMatch = fmBlock.match(missionLineRe);
  const hasProjectLine = /^\s*defaultProjectDir\s*:/m.test(fmBlock);

  let newFmBlock = fmBlock;
  let missionValue: string | null = null;
  if (missionLineMatch) {
    missionValue = missionLineMatch[2].trim();
    if (!hasProjectLine) {
      newFmBlock = fmBlock.replace(
        missionLineRe,
        `$1defaultProjectDir: ${missionValue}`,
      );
      result.renamedField = true;
    } else {
      // Both keys present; strip the legacy one to avoid drift.
      newFmBlock = fmBlock.replace(missionLineRe, '').replace(/\n{2,}/g, '\n');
      result.renamedField = true;
    }
  }

  // --- Resolve the current projects dir from whatever the frontmatter says. ---
  const projectLineRe = /^\s*defaultProjectDir\s*:\s*(.*)$/m;
  const projectLineMatch = newFmBlock.match(projectLineRe);
  const projectsDirRaw = projectLineMatch
    ? projectLineMatch[1].trim().replace(/^['"]|['"]$/g, '')
    : missionValue;

  const expand = (p: string): string =>
    p.startsWith('~')
      ? resolve(process.env.HOME ?? '/', p.slice(p.startsWith('~/') ? 2 : 1))
      : p;

  let resolvedProjectsDir = projectsDirRaw ? expand(projectsDirRaw) : null;

  // --- Directory rename (only if the value still points at a /missions dir). ---
  if (resolvedProjectsDir && resolvedProjectsDir.endsWith('/missions')) {
    const siblingProjectsDir = resolvedProjectsDir.replace(/\/missions$/, '/projects');
    if (
      (await fileExists(resolvedProjectsDir)) &&
      !(await fileExists(siblingProjectsDir))
    ) {
      try {
        await rename(resolvedProjectsDir, siblingProjectsDir);
        // Update the config line to point at the new dir. Preserve any ~ prefix.
        const newValue = projectsDirRaw!.endsWith('/missions')
          ? projectsDirRaw!.replace(/\/missions$/, '/projects')
          : siblingProjectsDir;
        newFmBlock = newFmBlock.replace(
          projectLineRe,
          `defaultProjectDir: ${newValue}`,
        );
        resolvedProjectsDir = siblingProjectsDir;
        result.renamedDir = true;
      } catch {
        // If rename fails (permissions, cross-device), leave both config and
        // filesystem alone. Scanner will still hit the legacy dir.
      }
    }
  }

  result.resolvedProjectsDir = resolvedProjectsDir;

  if (result.renamedField || result.renamedDir) {
    const newContent = `---\n${newFmBlock.replace(/\n+$/, '')}\n---\n${afterFm.startsWith('\n') ? afterFm.slice(1) : afterFm}`;
    try {
      await writeFile(configPath, newContent, 'utf-8');
    } catch {
      // If we can't persist the config, revert the flags so the caller
      // doesn't report a fake success.
      result.renamedField = false;
      result.renamedDir = false;
    }
  }

  return result;
}

/**
 * Format a concise summary line for startup logs. Empty string when nothing
 * material happened (caller should skip the log).
 */
export function summarizeMigration(
  project: ProjectFilesMigrationResult,
  config?: ConfigMigrationResult,
): string {
  const parts: string[] = [];
  if (project.renamedProjectFiles.length > 0) {
    const firstThree = project.renamedProjectFiles
      .map((p) => p.split('/')[0])
      .slice(0, 3)
      .join(', ');
    const more =
      project.renamedProjectFiles.length > 3
        ? ` and ${project.renamedProjectFiles.length - 3} more`
        : '';
    parts.push(
      `renamed mission.md → project.md in ${project.renamedProjectFiles.length} project${project.renamedProjectFiles.length === 1 ? '' : 's'} (${firstThree}${more})`,
    );
  }
  if (config?.renamedField) parts.push('updated config defaultMissionDir → defaultProjectDir');
  if (config?.renamedDir) parts.push('renamed projects directory on disk');
  if (project.legacyExtras.length > 0) {
    parts.push(
      `${project.legacyExtras.length} legacy agent.md / claude.md file${project.legacyExtras.length === 1 ? '' : 's'} left in place (no longer read)`,
    );
  }
  return parts.length ? `[syntaur] legacy migration: ${parts.join('; ')}` : '';
}
