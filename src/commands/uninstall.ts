import { resolve } from 'node:path';
import {
  detectClaudeMarketplaceForTarget,
  getConfiguredOrLegacyManagedPluginDir,
  getConfiguredOrLegacyMarketplacePath,
  getConfiguredProjectDir,
  removeClaudeMarketplaceEntry,
  removeSyntaurData,
  removeMarketplaceEntry,
  uninstallManagedPlugin,
} from '../utils/install.js';
import { syntaurRoot } from '../utils/paths.js';
import { confirmPrompt } from '../utils/prompt.js';

export interface UninstallOptions {
  claude?: boolean;
  codex?: boolean;
  data?: boolean;
  all?: boolean;
  yes?: boolean;
}

function expandTargets(options: UninstallOptions): {
  claude: boolean;
  codex: boolean;
  data: boolean;
} {
  if (options.all) {
    return { claude: true, codex: true, data: true };
  }

  if (options.claude || options.codex || options.data) {
    return {
      claude: Boolean(options.claude),
      codex: Boolean(options.codex),
      data: Boolean(options.data),
    };
  }

  return { claude: true, codex: true, data: false };
}

export async function uninstallCommand(options: UninstallOptions): Promise<void> {
  const targets = expandTargets(options);
  const actions: string[] = [];

  if (targets.claude) actions.push('Claude Code plugin');
  if (targets.codex) actions.push('Codex plugin');
  if (targets.data) actions.push('~/.syntaur data');

  if (actions.length === 0) {
    console.log('Nothing selected for uninstall.');
    return;
  }

  if (!options.yes) {
    const confirmed = await confirmPrompt(
      `Remove: ${actions.join(', ')}?`,
      false,
    );
    if (!confirmed) {
      console.log('Uninstall cancelled.');
      return;
    }
  }

  if (targets.claude) {
    const claudeTargetDir = await getConfiguredOrLegacyManagedPluginDir('claude');
    const claudeMarketplace = claudeTargetDir
      ? await detectClaudeMarketplaceForTarget(claudeTargetDir)
      : null;
    const result = await uninstallManagedPlugin(
      'claude',
      claudeTargetDir ?? undefined,
    );
    console.log(
      result.removed
        ? `Removed Claude Code plugin from ${result.targetDir}`
        : `Claude Code plugin not installed at ${result.targetDir}`,
    );
    if (claudeMarketplace) {
      const removedMarketplaceEntry = await removeClaudeMarketplaceEntry({
        manifestPath: claudeMarketplace.manifestPath,
        marketplaceRootDir: claudeMarketplace.rootDir,
        pluginTargetDir: claudeTargetDir ?? undefined,
      });
      if (removedMarketplaceEntry.removed) {
        console.log(`Removed Claude marketplace entry from ${removedMarketplaceEntry.manifestPath}`);
      }
    }
  }

  if (targets.codex) {
    const codexTargetDir = await getConfiguredOrLegacyManagedPluginDir('codex');
    const marketplacePath = await getConfiguredOrLegacyMarketplacePath();
    const result = await uninstallManagedPlugin(
      'codex',
      codexTargetDir ?? undefined,
    );
    console.log(
      result.removed
        ? `Removed Codex plugin from ${result.targetDir}`
        : `Codex plugin not installed at ${result.targetDir}`,
    );

    if (marketplacePath) {
      const marketplace = await removeMarketplaceEntry({
        marketplacePath,
        pluginTargetDir: codexTargetDir ?? undefined,
      });
      if (marketplace.removed) {
        console.log(`Removed Codex marketplace entry from ${marketplace.marketplacePath}`);
      }
    }
  }

  if (targets.data) {
    const configuredProjectDir = await getConfiguredProjectDir();
    await removeSyntaurData();
    console.log(`Removed ${syntaurRoot()}`);

    if (
      configuredProjectDir &&
      resolve(configuredProjectDir) !== resolve(syntaurRoot(), 'projects')
    ) {
      console.warn(
        `Warning: config.md pointed to an external project directory (${configuredProjectDir}). That directory was not removed automatically.`,
      );
    }
  }

  if (!targets.data) {
    console.log('User project data in ~/.syntaur was kept.');
  }
}
