import { updateIntegrationConfig } from '../utils/config.js';
import {
  getConfiguredOrLegacyManagedPluginDir,
  inspectInstallPath,
  installManagedPlugin,
  normalizeAbsoluteInstallPath,
  recommendPluginTargetDir,
  uninstallManagedPlugin,
} from '../utils/install.js';
import { confirmPrompt, isInteractiveTerminal, textPrompt } from '../utils/prompt.js';

export interface InstallPluginOptions {
  force?: boolean;
  link?: boolean;
  targetDir?: string;
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

export async function installPluginCommand(
  options: InstallPluginOptions,
): Promise<void> {
  const shouldPromptForTarget = Boolean(
    options.promptForTarget !== false &&
      isInteractiveTerminal() &&
      !options.targetDir,
  );
  const recommendedTargetDir = await recommendPluginTargetDir('claude');
  const targetDir = options.targetDir
    ? normalizeAbsoluteInstallPath(options.targetDir, 'Claude plugin target')
    : shouldPromptForTarget
      ? await promptForInstallPath('Claude plugin directory', recommendedTargetDir)
      : recommendedTargetDir;

  const previousTargetDir = await getConfiguredOrLegacyManagedPluginDir('claude');
  const migrating = Boolean(previousTargetDir && previousTargetDir !== targetDir);
  let previousInstall = previousTargetDir
    ? await inspectInstallPath('claude', previousTargetDir)
    : null;

  if (migrating && previousInstall?.exists && !previousInstall.managed) {
    throw new Error(
      `${previousTargetDir} exists but is not a Syntaur-managed install. Remove it manually before changing the Claude plugin location.`,
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
  await updateIntegrationConfig({ claudePluginDir: result.targetDir });

  if (migrating && previousInstall?.exists && previousInstall.managed && previousTargetDir) {
    const removed = await uninstallManagedPlugin('claude', previousTargetDir);
    if (removed.removed) {
      console.log(`Removed previous Claude Code plugin from ${removed.targetDir}`);
    }
    previousInstall = null;
  }

  console.log('Installed Syntaur plugin:');
  console.log(`  target: ${result.targetDir}`);
  console.log(`  source: ${result.sourceDir}`);
  console.log(`  mode: ${result.mode}`);
  console.log('\nThe plugin is now available in Claude Code.');
  console.log('  Skills: /grab-assignment, /plan-assignment, /complete-assignment');
  console.log('  Background: syntaur-protocol (auto-invoked)');
  console.log('  Hook: write boundary enforcement (PreToolUse)');
}
