import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileExists } from './fs.js';

export type PluginAgent = 'claude' | 'codex';

interface ClaudeSettingsFile {
  enabledPlugins?: Record<string, boolean | unknown>;
}

interface ClaudeInstalledPluginsFile {
  plugins?: Record<string, unknown>;
}

function settingsPathFor(agent: PluginAgent): string | null {
  if (agent === 'claude') return resolve(homedir(), '.claude', 'settings.json');
  // Codex: no equivalent settings file with enabledPlugins surface today.
  return null;
}

function installedPluginsPathFor(agent: PluginAgent): string | null {
  if (agent === 'claude') {
    return resolve(homedir(), '.claude', 'plugins', 'installed_plugins.json');
  }
  return null;
}

async function readJsonOrNull<T>(path: string | null): Promise<T | null> {
  if (!path) return null;
  if (!(await fileExists(path))) return null;
  try {
    const raw = await readFile(path, 'utf-8');
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

// Returns true when the syntaur plugin is enabled in any marketplace for the
// given agent. Used by installSkills() to skip writing skills globally when
// the plugin will already provide them via its manifest, avoiding duplicate
// skill registrations.
export async function isSyntaurPluginEnabledFor(agent: PluginAgent): Promise<boolean> {
  const settings = await readJsonOrNull<ClaudeSettingsFile>(settingsPathFor(agent));
  const enabled = settings?.enabledPlugins ?? {};
  for (const [key, value] of Object.entries(enabled)) {
    if (value !== true) continue;
    const atIndex = key.lastIndexOf('@');
    const pluginName = atIndex > 0 ? key.slice(0, atIndex) : key;
    if (pluginName === 'syntaur') return true;
  }
  return false;
}

// Returns true when the syntaur plugin's files are physically installed
// for the agent (regardless of enabled state). This is a weaker signal —
// installSkills() prefers `enabled` so a plugin installed-but-disabled
// doesn't suppress skills.
export async function isSyntaurPluginInstalledFor(agent: PluginAgent): Promise<boolean> {
  const data = await readJsonOrNull<ClaudeInstalledPluginsFile>(installedPluginsPathFor(agent));
  if (!data?.plugins) return false;
  for (const key of Object.keys(data.plugins)) {
    const atIndex = key.lastIndexOf('@');
    const pluginName = atIndex > 0 ? key.slice(0, atIndex) : key;
    if (pluginName === 'syntaur') return true;
  }
  return false;
}
