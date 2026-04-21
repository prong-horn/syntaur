import { readdir } from 'node:fs/promises';
import { readConfig } from './utils/config.js';
import {
  getConfiguredOrLegacyManagedPluginDir,
  getConfiguredOrLegacyMarketplacePath,
  isSyntaurDataInstalled,
} from './utils/install.js';

async function hasAnyProjectContent(projectsDir: string): Promise<boolean> {
  try {
    const entries = await readdir(projectsDir, { withFileTypes: true });
    return entries.some((entry) => entry.isDirectory());
  } catch {
    return false;
  }
}

async function isSetupComplete(): Promise<boolean> {
  const config = await readConfig();
  if (config.onboarding.completed) {
    return true;
  }

  const [
    claudePluginDir,
    codexPluginDir,
    codexMarketplacePath,
    hasProjectContent,
  ] = await Promise.all([
    getConfiguredOrLegacyManagedPluginDir('claude'),
    getConfiguredOrLegacyManagedPluginDir('codex'),
    getConfiguredOrLegacyMarketplacePath(),
    hasAnyProjectContent(config.defaultProjectDir),
  ]);

  return Boolean(
    claudePluginDir ||
      codexPluginDir ||
      codexMarketplacePath ||
      hasProjectContent,
  );
}

export async function getDefaultCommandName(): Promise<'setup' | 'dashboard'> {
  if (!(await isSyntaurDataInstalled())) {
    return 'setup';
  }

  return (await isSetupComplete()) ? 'dashboard' : 'setup';
}
