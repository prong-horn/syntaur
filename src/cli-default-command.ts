import { readdir } from 'node:fs/promises';
import { readConfig } from './utils/config.js';
import {
  getConfiguredOrLegacyManagedPluginDir,
  getConfiguredOrLegacyMarketplacePath,
  isSyntaurDataInstalled,
} from './utils/install.js';

async function hasAnyMissionContent(missionsDir: string): Promise<boolean> {
  try {
    const entries = await readdir(missionsDir, { withFileTypes: true });
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
    hasMissionContent,
  ] = await Promise.all([
    getConfiguredOrLegacyManagedPluginDir('claude'),
    getConfiguredOrLegacyManagedPluginDir('codex'),
    getConfiguredOrLegacyMarketplacePath(),
    hasAnyMissionContent(config.defaultMissionDir),
  ]);

  return Boolean(
    claudePluginDir ||
      codexPluginDir ||
      codexMarketplacePath ||
      hasMissionContent,
  );
}

export async function getDefaultCommandName(): Promise<'setup' | 'dashboard'> {
  if (!(await isSyntaurDataInstalled())) {
    return 'setup';
  }

  return (await isSetupComplete()) ? 'dashboard' : 'setup';
}
