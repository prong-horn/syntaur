import { resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
import {
  symlink,
  readlink,
  lstat,
  rm,
  readFile,
  writeFile,
} from 'node:fs/promises';
import { ensureDir, fileExists } from '../utils/fs.js';
import { findPackageRoot } from '../utils/package-root.js';

export interface InstallCodexPluginOptions {
  force?: boolean;
}

interface MarketplaceEntry {
  name: string;
  source: {
    source: 'local';
    path: string;
  };
  policy: {
    installation: 'AVAILABLE';
    authentication: 'ON_INSTALL';
  };
  category: 'Coding';
}

interface MarketplaceFile {
  name: string;
  interface?: {
    displayName?: string;
  };
  plugins: MarketplaceEntry[];
}

function buildSyntaurEntry(): MarketplaceEntry {
  return {
    name: 'syntaur',
    source: {
      source: 'local',
      path: './plugins/syntaur',
    },
    policy: {
      installation: 'AVAILABLE',
      authentication: 'ON_INSTALL',
    },
    category: 'Coding',
  };
}

export async function installCodexPluginCommand(
  options: InstallCodexPluginOptions,
): Promise<void> {
  const packageRoot = await findPackageRoot('plugins/syntaur');
  const pluginSource = resolve(packageRoot, 'plugins', 'syntaur');

  if (!(await fileExists(pluginSource))) {
    throw new Error(
      `Codex plugin source directory not found at ${pluginSource}. Are you running from the syntaur repo?`,
    );
  }

  const home = homedir();
  const pluginsDir = resolve(home, 'plugins');
  const targetLink = resolve(pluginsDir, 'syntaur');

  await ensureDir(pluginsDir);

  let targetExists = false;
  try {
    await lstat(targetLink);
    targetExists = true;
  } catch {
    targetExists = false;
  }

  if (targetExists) {
    try {
      const existingTarget = await readlink(targetLink);
      const resolvedExisting = resolve(dirname(targetLink), existingTarget);
      if (resolvedExisting === pluginSource) {
        // Already linked correctly.
      } else if (!options.force) {
        throw new Error(
          `${targetLink} already exists and points elsewhere. Use --force to overwrite.`,
        );
      } else {
        await rm(targetLink, { recursive: true, force: true });
      }
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.includes('already exists and points elsewhere')
      ) {
        throw error;
      }
      if (!options.force) {
        throw new Error(
          `${targetLink} already exists and is not the expected symlink. Use --force to overwrite.`,
        );
      }
      await rm(targetLink, { recursive: true, force: true });
    }
  }

  if (!(await fileExists(targetLink))) {
    await symlink(pluginSource, targetLink, 'dir');
  }

  const marketplaceDir = resolve(home, '.agents', 'plugins');
  const marketplacePath = resolve(marketplaceDir, 'marketplace.json');
  await ensureDir(marketplaceDir);

  let marketplace: MarketplaceFile;
  if (await fileExists(marketplacePath)) {
    const raw = await readFile(marketplacePath, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<MarketplaceFile>;
    marketplace = {
      name: parsed.name ?? 'local',
      interface: parsed.interface ?? { displayName: 'Local Plugins' },
      plugins: Array.isArray(parsed.plugins)
        ? (parsed.plugins as MarketplaceEntry[])
        : [],
    };
  } else {
    marketplace = {
      name: 'local',
      interface: {
        displayName: 'Local Plugins',
      },
      plugins: [],
    };
  }

  const entry = buildSyntaurEntry();
  const existingIndex = marketplace.plugins.findIndex(
    (plugin) => plugin.name === entry.name,
  );

  if (existingIndex >= 0) {
    const existingEntry = marketplace.plugins[existingIndex];
    const sameEntry =
      JSON.stringify(existingEntry) === JSON.stringify(entry);

    if (!sameEntry) {
      if (!options.force) {
        throw new Error(
          `Marketplace entry "${entry.name}" already exists with different settings. Use --force to replace it.`,
        );
      }
      marketplace.plugins[existingIndex] = entry;
    }
  } else {
    marketplace.plugins.push(entry);
  }

  await writeFile(
    marketplacePath,
    `${JSON.stringify(marketplace, null, 2)}\n`,
    'utf-8',
  );

  console.log('Installed Syntaur Codex plugin:');
  console.log(`  ${targetLink} -> ${pluginSource}`);
  console.log(`  marketplace: ${marketplacePath}`);
  console.log('\nThe plugin is now available to Codex.');
  console.log(
    '  Skills: syntaur-protocol, create-mission, create-assignment, grab-assignment, plan-assignment, complete-assignment, track-session',
  );
  console.log('  Command: /track-session');
  console.log('  Hooks: write boundary enforcement, session cleanup');
}
