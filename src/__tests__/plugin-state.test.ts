import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  isSyntaurPluginEnabledFor,
  isSyntaurPluginInstalledFor,
} from '../utils/plugin-state.js';

describe('plugin-state', () => {
  let homeDir: string;
  const originalHome = process.env.HOME;

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'syntaur-plugin-state-'));
    process.env.HOME = homeDir;
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    await rm(homeDir, { recursive: true, force: true });
  });

  it('returns false when settings.json does not exist', async () => {
    expect(await isSyntaurPluginEnabledFor('claude')).toBe(false);
  });

  it('returns true when syntaur plugin is enabled in any marketplace', async () => {
    const settingsPath = resolve(homeDir, '.claude', 'settings.json');
    await mkdir(resolve(homeDir, '.claude'), { recursive: true });
    await writeFile(
      settingsPath,
      JSON.stringify({
        enabledPlugins: {
          'github@claude-plugins-official': true,
          'syntaur@user-plugins': true,
        },
      }),
      'utf-8',
    );
    expect(await isSyntaurPluginEnabledFor('claude')).toBe(true);
  });

  it('returns false when syntaur plugin is registered but disabled', async () => {
    const settingsPath = resolve(homeDir, '.claude', 'settings.json');
    await mkdir(resolve(homeDir, '.claude'), { recursive: true });
    await writeFile(
      settingsPath,
      JSON.stringify({
        enabledPlugins: {
          'syntaur@user-plugins': false,
          'forge@user-plugins': true,
        },
      }),
      'utf-8',
    );
    expect(await isSyntaurPluginEnabledFor('claude')).toBe(false);
  });

  it('detects installed-but-not-enabled plugin via installed_plugins.json', async () => {
    const installedPath = resolve(
      homeDir,
      '.claude',
      'plugins',
      'installed_plugins.json',
    );
    await mkdir(resolve(homeDir, '.claude', 'plugins'), { recursive: true });
    await writeFile(
      installedPath,
      JSON.stringify({
        version: 2,
        plugins: {
          'syntaur@user-plugins': [{ scope: 'user' }],
        },
      }),
      'utf-8',
    );
    expect(await isSyntaurPluginInstalledFor('claude')).toBe(true);
    expect(await isSyntaurPluginEnabledFor('claude')).toBe(false);
  });

  it('returns false for codex (no enabledPlugins surface today)', async () => {
    expect(await isSyntaurPluginEnabledFor('codex')).toBe(false);
    expect(await isSyntaurPluginInstalledFor('codex')).toBe(false);
  });
});
