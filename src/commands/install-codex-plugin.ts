import { updateIntegrationConfig } from '../utils/config.js';
import {
  ensureMarketplaceEntry,
  getConfiguredOrLegacyManagedPluginDir,
  getConfiguredOrLegacyMarketplacePath,
  hasSyntaurMarketplaceEntry,
  inspectInstallPath,
  installManagedPlugin,
  normalizeAbsoluteInstallPath,
  recommendMarketplacePath,
  recommendPluginTargetDir,
  removeMarketplaceEntry,
  uninstallManagedPlugin,
} from '../utils/install.js';
import { confirmPrompt, isInteractiveTerminal, textPrompt } from '../utils/prompt.js';

export interface InstallCodexPluginOptions {
  force?: boolean;
  link?: boolean;
  targetDir?: string;
  marketplacePath?: string;
  promptForTarget?: boolean;
}

async function promptForInstallPath(
  question: string,
  recommendedPath: string,
): Promise<string> {
  while (true) {
    const answer = await textPrompt(question, recommendedPath);
    try {
      return normalizeAbsoluteInstallPath(answer, question);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
    }
  }
}

export async function installCodexPluginCommand(
  options: InstallCodexPluginOptions,
): Promise<void> {
  const promptForTarget = Boolean(
    options.promptForTarget !== false &&
      isInteractiveTerminal() &&
      (!options.targetDir || !options.marketplacePath),
  );
  const recommendedTargetDir = await recommendPluginTargetDir('codex');
  const recommendedMarketplacePath = await recommendMarketplacePath();
  const targetDir = options.targetDir
    ? normalizeAbsoluteInstallPath(options.targetDir, 'Codex plugin target')
    : promptForTarget
      ? await promptForInstallPath('Codex plugin directory', recommendedTargetDir)
      : recommendedTargetDir;
  const marketplacePath = options.marketplacePath
    ? normalizeAbsoluteInstallPath(options.marketplacePath, 'Codex marketplace path')
    : promptForTarget
      ? await promptForInstallPath('Codex marketplace file path', recommendedMarketplacePath)
      : recommendedMarketplacePath;

  const previousTargetDir = await getConfiguredOrLegacyManagedPluginDir('codex');
  const previousMarketplacePath = await getConfiguredOrLegacyMarketplacePath();
  const pluginPathChanged = Boolean(previousTargetDir && previousTargetDir !== targetDir);
  const marketplacePathChanged = Boolean(
    previousMarketplacePath && previousMarketplacePath !== marketplacePath,
  );
  const previousInstall = previousTargetDir
    ? await inspectInstallPath('codex', previousTargetDir)
    : null;
  const previousMarketplaceEntryExists = Boolean(
    previousMarketplacePath &&
      previousTargetDir &&
      await hasSyntaurMarketplaceEntry(previousMarketplacePath, previousTargetDir),
  );

  if (pluginPathChanged && previousInstall?.exists && !previousInstall.managed) {
    throw new Error(
      `${previousTargetDir} exists but is not a Syntaur-managed install. Remove it manually before changing the Codex plugin location.`,
    );
  }

  if (
    (pluginPathChanged || marketplacePathChanged) &&
    (previousInstall?.exists || previousMarketplaceEntryExists) &&
    isInteractiveTerminal()
  ) {
    const confirmed = await confirmPrompt(
      `Move the Codex integration to ${targetDir} and ${marketplacePath} and remove the previous Syntaur-managed integration?`,
      true,
    );
    if (!confirmed) {
      throw new Error('Install cancelled.');
    }
  }

  const result = await installManagedPlugin({
    pluginKind: 'codex',
    force: options.force,
    link: options.link,
    targetDir,
  });
  const marketplace = await ensureMarketplaceEntry({
    marketplacePath,
    pluginTargetDir: result.targetDir,
    expectedExistingPluginTargetDir:
      previousMarketplacePath === marketplacePath ? previousTargetDir : null,
  });
  await updateIntegrationConfig({
    codexPluginDir: result.targetDir,
    codexMarketplacePath: marketplace.marketplacePath,
  });

  if (pluginPathChanged && previousInstall?.exists && previousInstall.managed && previousTargetDir) {
    const removed = await uninstallManagedPlugin('codex', previousTargetDir);
    if (removed.removed) {
      console.log(`Removed previous Codex plugin from ${removed.targetDir}`);
    }
  }

  if (
    previousMarketplacePath &&
    previousTargetDir &&
    previousMarketplacePath !== marketplace.marketplacePath
  ) {
    const removedMarketplace = await removeMarketplaceEntry({
      marketplacePath: previousMarketplacePath,
      pluginTargetDir: previousTargetDir,
    });
    if (removedMarketplace.removed) {
      console.log(`Removed previous Codex marketplace entry from ${removedMarketplace.marketplacePath}`);
    }
  }

  console.log('Installed Syntaur Codex plugin:');
  console.log(`  target: ${result.targetDir}`);
  console.log(`  source: ${result.sourceDir}`);
  console.log(`  mode: ${result.mode}`);
  console.log(`  marketplace: ${marketplace.marketplacePath}`);
  console.log('\nThe plugin is now available to Codex.');
  console.log(
    '  Skills: syntaur-protocol, create-project, create-assignment, grab-assignment, plan-assignment, complete-assignment, track-session',
  );
  console.log('  Command: /track-session');
  console.log('  Hooks: write boundary enforcement, session cleanup');
}
