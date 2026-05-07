import { updateIntegrationConfig } from '../utils/config.js';
import {
  detectClaudeMarketplaceForTarget,
  ensureClaudeMarketplaceEntry,
  ensureKnownClaudeMarketplaceForRoot,
  getConfiguredOrLegacyManagedPluginDir,
  inspectInstallPath,
  installManagedPlugin,
  normalizeAbsoluteInstallPath,
  removeClaudeMarketplaceEntry,
  recommendPluginTargetDir,
  getDefaultPluginTargetDir,
  setSyntaurPluginEnabled,
  uninstallManagedPlugin,
} from '../utils/install.js';
import { confirmPrompt, isInteractiveTerminal, textPrompt } from '../utils/prompt.js';
import { installSkillsWithReport, formatInstallReport } from '../utils/install-skills.js';

export interface InstallPluginOptions {
  force?: boolean;
  link?: boolean;
  targetDir?: string;
  promptForTarget?: boolean;
  forceSkills?: boolean;
  skipSkills?: boolean;
  // When true, set `enabledPlugins["syntaur@<marketplace>"] = true` in
  // ~/.claude/settings.json after install. Default: do not modify settings.
  enable?: boolean;
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

export async function installPluginCommand(
  options: InstallPluginOptions,
): Promise<void> {
  // SYNTAUR_PLUGIN_TARGET overrides discovery for power users / CI.
  const envOverride = process.env.SYNTAUR_PLUGIN_TARGET?.trim();
  const shouldPromptForTarget = Boolean(
    options.promptForTarget !== false &&
      isInteractiveTerminal() &&
      !options.targetDir &&
      !envOverride,
  );
  const recommendedTargetDir = await recommendPluginTargetDir('claude');
  const targetDir = options.targetDir
    ? normalizeAbsoluteInstallPath(options.targetDir, 'Claude plugin target')
    : envOverride
      ? normalizeAbsoluteInstallPath(envOverride, 'SYNTAUR_PLUGIN_TARGET')
      : shouldPromptForTarget
        ? await promptForInstallPath('Claude plugin directory', recommendedTargetDir)
        : recommendedTargetDir;

  const previousTargetDir = await getConfiguredOrLegacyManagedPluginDir('claude');
  const migrating = Boolean(previousTargetDir && previousTargetDir !== targetDir);
  let previousInstall = previousTargetDir
    ? await inspectInstallPath('claude', previousTargetDir)
    : null;
  const previousMarketplace = previousTargetDir
    ? await detectClaudeMarketplaceForTarget(previousTargetDir)
    : null;
  const legacyTargetDir = getDefaultPluginTargetDir('claude');
  const legacyInstall = targetDir !== legacyTargetDir
    ? await inspectInstallPath('claude', legacyTargetDir)
    : null;

  if (migrating && previousInstall?.exists && !previousInstall.managed) {
    throw new Error(
      `${previousTargetDir} exists but is not a Syntaur-managed install. Remove it manually before changing the Claude plugin location.`,
    );
  }

  if (
    targetDir !== legacyTargetDir &&
    legacyInstall?.exists &&
    !legacyInstall.managed &&
    (!previousTargetDir || previousTargetDir !== legacyTargetDir)
  ) {
    console.warn(
      `Warning: ${legacyTargetDir} already exists and is not a Syntaur-managed install. Syntaur will use ${targetDir} instead.`,
    );
  }

  if (migrating && previousInstall?.exists && previousInstall.managed && isInteractiveTerminal()) {
    const confirmed = await confirmPrompt(
      `Move the Claude Code plugin from ${previousTargetDir} to ${targetDir} and remove the old install?`,
      true,
    );
    if (!confirmed) {
      throw new Error('Install cancelled.');
    }
  }

  const result = await installManagedPlugin({
    pluginKind: 'claude',
    force: options.force,
    link: options.link,
    targetDir,
  });
  const currentMarketplace = await detectClaudeMarketplaceForTarget(result.targetDir);
  let knownMarketplaceState: { added: boolean; updated: boolean } | null = null;
  if (currentMarketplace) {
    await ensureClaudeMarketplaceEntry({
      marketplaceRootDir: currentMarketplace.rootDir,
      manifestPath: currentMarketplace.manifestPath,
      pluginTargetDir: result.targetDir,
      expectedExistingPluginTargetDir:
        previousMarketplace && previousMarketplace.manifestPath === currentMarketplace.manifestPath
          ? previousTargetDir
          : null,
    });
    // Ensure Claude itself can see this marketplace. Historical bug:
    // marketplace.json was correct on disk but known_marketplaces.json
    // didn't list the marketplace, so the /plugin UI showed nothing.
    knownMarketplaceState = await ensureKnownClaudeMarketplaceForRoot({
      name: currentMarketplace.name,
      rootDir: currentMarketplace.rootDir,
    });
  } else {
    console.warn(
      `Warning: ${result.targetDir} is not inside a Claude Code marketplace ` +
        `(expected parent path of the form ~/.claude/plugins/marketplaces/<name>/plugins/syntaur). ` +
        `The plugin files were copied, but Claude Code will not discover them until you place them inside a marketplace.`,
    );
  }
  await updateIntegrationConfig({ claudePluginDir: result.targetDir });

  if (
    previousMarketplace &&
    previousTargetDir &&
    (!currentMarketplace || currentMarketplace.manifestPath !== previousMarketplace.manifestPath)
  ) {
    const removedMarketplaceEntry = await removeClaudeMarketplaceEntry({
      manifestPath: previousMarketplace.manifestPath,
      marketplaceRootDir: previousMarketplace.rootDir,
      pluginTargetDir: previousTargetDir,
    });
    if (removedMarketplaceEntry.removed) {
      console.log(`Removed previous Claude marketplace entry from ${removedMarketplaceEntry.manifestPath}`);
    }
  }

  if (migrating && previousInstall?.exists && previousInstall.managed && previousTargetDir) {
    const removed = await uninstallManagedPlugin('claude', previousTargetDir);
    if (removed.removed) {
      console.log(`Removed previous Claude Code plugin from ${removed.targetDir}`);
    }
    previousInstall = null;
  }

  // Optional: enable the plugin in settings.json so it activates without
  // the user having to flip it via /plugin.
  let enableResult: Awaited<ReturnType<typeof setSyntaurPluginEnabled>> | null = null;
  if (options.enable && currentMarketplace) {
    try {
      enableResult = await setSyntaurPluginEnabled({
        marketplaceName: currentMarketplace.name,
        enabled: true,
      });
    } catch (error) {
      console.warn(
        `Warning: could not enable plugin — ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  console.log('Installed Syntaur plugin:');
  console.log(`  target: ${result.targetDir}`);
  console.log(`  source: ${result.sourceDir}`);
  console.log(`  mode: ${result.mode}`);
  if (currentMarketplace) {
    console.log(`  marketplace: ${currentMarketplace.manifestPath}`);
    if (knownMarketplaceState) {
      const tag = knownMarketplaceState.added
        ? 'registered (added)'
        : knownMarketplaceState.updated
          ? 'registered (updated)'
          : 'already registered';
      console.log(`  known_marketplaces.json: ${tag}`);
    }
    const enabledKey = `syntaur@${currentMarketplace.name}`;
    if (enableResult) {
      console.log(
        `  enabledPlugins: ${enabledKey} = ${enableResult.current}` +
          (enableResult.changed ? '' : ' (already)'),
      );
    } else {
      console.log(
        `  enabledPlugins: ${enabledKey} not modified — run /plugin to enable, or pass --enable next time`,
      );
    }
  }
  if (!options.skipSkills) {
    try {
      // The plugin's plugin.json declares its skills inline, so enabling
      // the plugin will load them. installSkillsWithReport short-circuits
      // when the plugin is enabled to avoid duplicate registrations; pass
      // --force-skills to override and write to ~/.claude/skills/ anyway.
      const skillReport = await installSkillsWithReport({
        target: 'claude',
        force: options.forceSkills,
        ignorePluginActive: options.forceSkills,
      });
      console.log('');
      console.log(formatInstallReport(skillReport, 'claude'));
    } catch (error) {
      console.warn(
        `Warning: skill install failed — ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  console.log('\nThe plugin is now available in Claude Code.');
  console.log('  Slash commands: /grab-assignment, /plan-assignment, /complete-assignment, /create-assignment, /create-project, /track-session, /clear-assignment, /manage-statuses');
  console.log('  Background: syntaur-protocol skill (auto-invoked)');
  console.log('  Hook: write boundary enforcement (PreToolUse) + SessionStart/End');
}
