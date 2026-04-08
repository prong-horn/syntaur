import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { symlink, readlink, lstat, rm } from 'node:fs/promises';
import { ensureDir, fileExists } from '../utils/fs.js';
import { findPackageRoot } from '../utils/package-root.js';

export interface InstallPluginOptions {
  force?: boolean;
}

export async function installPluginCommand(
  options: InstallPluginOptions,
): Promise<void> {
  // Resolve the plugin source directory relative to this package's root
  const packageRoot = await findPackageRoot('plugin');
  const pluginSource = resolve(packageRoot, 'plugin');

  if (!(await fileExists(pluginSource))) {
    throw new Error(
      `Plugin source directory not found at ${pluginSource}. Are you running from the syntaur repo?`,
    );
  }

  const pluginsDir = resolve(homedir(), '.claude', 'plugins');
  const targetLink = resolve(pluginsDir, 'syntaur');

  // Ensure ~/.claude/plugins/ exists
  await ensureDir(pluginsDir);

  // Check if target already exists
  let targetExists = false;
  try {
    await lstat(targetLink);
    targetExists = true;
  } catch {
    // Does not exist, which is fine
  }

  if (targetExists) {
    // Check if it's already a symlink to the right place
    try {
      const existingTarget = await readlink(targetLink);
      const resolvedExisting = resolve(dirname(targetLink), existingTarget);
      if (resolvedExisting === pluginSource) {
        console.log(
          `Syntaur plugin already installed at ${targetLink} -> ${pluginSource}`,
        );
        return;
      }
    } catch {
      // Not a symlink, it's a regular file/directory
    }

    if (!options.force) {
      throw new Error(
        `${targetLink} already exists and points elsewhere. Use --force to overwrite.`,
      );
    }

    // Remove existing
    await rm(targetLink, { recursive: true, force: true });
    console.log(`Removed existing ${targetLink}`);
  }

  // Create symlink
  await symlink(pluginSource, targetLink, 'dir');

  console.log(`Installed Syntaur plugin:`);
  console.log(`  ${targetLink} -> ${pluginSource}`);
  console.log(`\nThe plugin is now available in Claude Code.`);
  console.log(`  Skills: /grab-assignment, /plan-assignment, /complete-assignment`);
  console.log(`  Background: syntaur-protocol (auto-invoked)`);
  console.log(`  Hook: write boundary enforcement (PreToolUse)`);
}
