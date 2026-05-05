import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, readFile, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { installPluginCommand } from '../commands/install-plugin.js';
import {
  ensureKnownClaudeMarketplaceForRoot,
  setSyntaurPluginEnabled,
} from '../utils/install.js';

// These tests focus on the marketplace integration steps that have
// historically broken when the plugin was installed: ensuring
// known_marketplaces.json is registered, marketplace.json gets a syntaur
// entry, and settings.json's enabledPlugins flag toggles correctly.

describe('install-plugin marketplace integration', () => {
  let homeDir: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'syntaur-installplugin-'));
    originalHome = process.env.HOME;
    process.env.HOME = homeDir;
    process.env.SYNTAUR_TEST_HOME = homeDir;
    // ~/.syntaur/config.md is required by integration config; bootstrap.
    await mkdir(resolve(homeDir, '.syntaur'), { recursive: true });
    await writeFile(
      resolve(homeDir, '.syntaur', 'config.md'),
      '---\ndefaultProjectDir: ' + resolve(homeDir, '.syntaur', 'projects') + '\n---\n',
      'utf-8',
    );
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    delete process.env.SYNTAUR_TEST_HOME;
    delete process.env.SYNTAUR_PLUGIN_TARGET;
    await rm(homeDir, { recursive: true, force: true });
  });

  it('registers a freshly created marketplace in known_marketplaces.json', async () => {
    // Clean slate: no existing marketplaces.
    await rm(resolve(homeDir, '.claude'), { recursive: true, force: true });

    await installPluginCommand({});

    const known = JSON.parse(
      await readFile(
        resolve(homeDir, '.claude', 'plugins', 'known_marketplaces.json'),
        'utf-8',
      ),
    );
    expect(known['user-plugins']).toBeDefined();
    expect(known['user-plugins'].source.source).toBe('directory');
    expect(known['user-plugins'].installLocation).toBe(
      resolve(homeDir, '.claude', 'plugins', 'marketplaces', 'user-plugins'),
    );
  });

  it('adds the syntaur entry to an existing marketplace.json without overwriting unrelated plugins', async () => {
    const marketplaceRoot = resolve(
      homeDir,
      '.claude',
      'plugins',
      'marketplaces',
      'user-plugins',
    );
    const manifestPath = resolve(marketplaceRoot, '.claude-plugin', 'marketplace.json');
    await mkdir(resolve(marketplaceRoot, 'plugins'), { recursive: true });
    await mkdir(resolve(marketplaceRoot, '.claude-plugin'), { recursive: true });
    await writeFile(
      manifestPath,
      JSON.stringify({
        name: 'user-plugins',
        plugins: [
          { name: 'forge', source: './plugins/forge', version: '1.0.0' },
        ],
      }),
      'utf-8',
    );

    await installPluginCommand({});

    const updated = JSON.parse(await readFile(manifestPath, 'utf-8'));
    expect(updated.plugins.find((p: any) => p.name === 'forge')).toBeDefined();
    expect(updated.plugins.find((p: any) => p.name === 'syntaur')).toBeDefined();
    // Plugins should be sorted by name on write.
    const names = updated.plugins.map((p: any) => p.name);
    expect(names).toEqual([...names].sort());
  });

  it('writes a backup of marketplace.json before mutating it', async () => {
    const marketplaceRoot = resolve(
      homeDir,
      '.claude',
      'plugins',
      'marketplaces',
      'user-plugins',
    );
    const manifestPath = resolve(marketplaceRoot, '.claude-plugin', 'marketplace.json');
    await mkdir(resolve(marketplaceRoot, 'plugins'), { recursive: true });
    await mkdir(resolve(marketplaceRoot, '.claude-plugin'), { recursive: true });
    const originalContent = JSON.stringify({
      name: 'user-plugins',
      plugins: [],
    });
    await writeFile(manifestPath, originalContent, 'utf-8');

    await installPluginCommand({});

    // A backup file should exist alongside.
    const dirEntries = await readFile(manifestPath, 'utf-8');
    expect(dirEntries).toContain('"syntaur"'); // proves the file was rewritten

    // Find the .bak-* file
    const { readdir } = await import('node:fs/promises');
    const siblings = await readdir(resolve(marketplaceRoot, '.claude-plugin'));
    const backups = siblings.filter((n) => n.startsWith('marketplace.json.bak-'));
    expect(backups.length).toBeGreaterThanOrEqual(1);
    const backupContent = await readFile(
      resolve(marketplaceRoot, '.claude-plugin', backups[0]),
      'utf-8',
    );
    expect(backupContent).toBe(originalContent);
  });

  it('refuses to overwrite a marketplace.json that is not valid JSON', async () => {
    const marketplaceRoot = resolve(
      homeDir,
      '.claude',
      'plugins',
      'marketplaces',
      'user-plugins',
    );
    const manifestPath = resolve(marketplaceRoot, '.claude-plugin', 'marketplace.json');
    await mkdir(resolve(marketplaceRoot, 'plugins'), { recursive: true });
    await mkdir(resolve(marketplaceRoot, '.claude-plugin'), { recursive: true });
    await writeFile(manifestPath, 'this is not { valid json', 'utf-8');

    // Pre-populate known_marketplaces so install-plugin doesn't try to bootstrap.
    await mkdir(resolve(homeDir, '.claude', 'plugins'), { recursive: true });
    await writeFile(
      resolve(homeDir, '.claude', 'plugins', 'known_marketplaces.json'),
      JSON.stringify({
        'user-plugins': {
          source: { source: 'directory', path: marketplaceRoot },
          installLocation: marketplaceRoot,
        },
      }),
      'utf-8',
    );

    // Without the plugin discovery succeeding into this manifest, the
    // install command surfaces a refusal — propagated as a thrown Error.
    await expect(installPluginCommand({})).rejects.toThrow(/not valid JSON/);
  });

  it('--enable flips enabledPlugins["syntaur@<marketplace>"] in settings.json', async () => {
    await installPluginCommand({ enable: true });

    const settings = JSON.parse(
      await readFile(resolve(homeDir, '.claude', 'settings.json'), 'utf-8'),
    );
    expect(settings.enabledPlugins['syntaur@user-plugins']).toBe(true);
  });

  it('without --enable, leaves settings.json untouched', async () => {
    await installPluginCommand({});
    const settingsPath = resolve(homeDir, '.claude', 'settings.json');
    // settings.json should not be created by install-plugin alone.
    await expect(lstat(settingsPath)).rejects.toThrow();
  });

  it('SYNTAUR_PLUGIN_TARGET env var overrides discovery', async () => {
    const customMarketplaceRoot = resolve(
      homeDir,
      '.claude',
      'plugins',
      'marketplaces',
      'my-marketplace',
    );
    await mkdir(resolve(customMarketplaceRoot, 'plugins'), { recursive: true });
    await mkdir(resolve(customMarketplaceRoot, '.claude-plugin'), { recursive: true });
    await writeFile(
      resolve(customMarketplaceRoot, '.claude-plugin', 'marketplace.json'),
      JSON.stringify({ name: 'my-marketplace', plugins: [] }),
      'utf-8',
    );

    process.env.SYNTAUR_PLUGIN_TARGET = resolve(
      customMarketplaceRoot,
      'plugins',
      'syntaur',
    );

    await installPluginCommand({});

    const installedManifest = JSON.parse(
      await readFile(
        resolve(customMarketplaceRoot, '.claude-plugin', 'marketplace.json'),
        'utf-8',
      ),
    );
    expect(installedManifest.plugins.some((p: any) => p.name === 'syntaur')).toBe(true);

    const known = JSON.parse(
      await readFile(
        resolve(homeDir, '.claude', 'plugins', 'known_marketplaces.json'),
        'utf-8',
      ),
    );
    expect(known['my-marketplace']?.installLocation).toBe(customMarketplaceRoot);
  });
});

describe('ensureKnownClaudeMarketplaceForRoot (idempotent)', () => {
  let homeDir: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'syntaur-known-'));
    originalHome = process.env.HOME;
    process.env.HOME = homeDir;
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    await rm(homeDir, { recursive: true, force: true });
  });

  it('adds an entry on first call and reports added=true', async () => {
    const result = await ensureKnownClaudeMarketplaceForRoot({
      name: 'user-plugins',
      rootDir: '/some/path',
    });
    expect(result.added).toBe(true);
    expect(result.updated).toBe(false);
  });

  it('returns added=false, updated=false when already up to date', async () => {
    await ensureKnownClaudeMarketplaceForRoot({
      name: 'user-plugins',
      rootDir: '/some/path',
    });
    const second = await ensureKnownClaudeMarketplaceForRoot({
      name: 'user-plugins',
      rootDir: '/some/path',
    });
    expect(second.added).toBe(false);
    expect(second.updated).toBe(false);
  });

  it('updates the path when the same name is registered with a different location', async () => {
    await ensureKnownClaudeMarketplaceForRoot({
      name: 'user-plugins',
      rootDir: '/old/path',
    });
    const second = await ensureKnownClaudeMarketplaceForRoot({
      name: 'user-plugins',
      rootDir: '/new/path',
    });
    expect(second.added).toBe(false);
    expect(second.updated).toBe(true);
  });
});

describe('setSyntaurPluginEnabled', () => {
  let homeDir: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'syntaur-enable-'));
    originalHome = process.env.HOME;
    process.env.HOME = homeDir;
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    await rm(homeDir, { recursive: true, force: true });
  });

  it('creates settings.json on first call when missing', async () => {
    const result = await setSyntaurPluginEnabled({
      marketplaceName: 'user-plugins',
      enabled: true,
    });
    expect(result.changed).toBe(true);
    expect(result.previous).toBeUndefined();
    expect(result.current).toBe(true);

    const settings = JSON.parse(
      await readFile(resolve(homeDir, '.claude', 'settings.json'), 'utf-8'),
    );
    expect(settings.enabledPlugins['syntaur@user-plugins']).toBe(true);
  });

  it('preserves unrelated keys when toggling', async () => {
    await mkdir(resolve(homeDir, '.claude'), { recursive: true });
    await writeFile(
      resolve(homeDir, '.claude', 'settings.json'),
      JSON.stringify({
        voiceEnabled: true,
        enabledPlugins: { 'forge@user-plugins': true },
      }),
      'utf-8',
    );
    const result = await setSyntaurPluginEnabled({
      marketplaceName: 'user-plugins',
      enabled: true,
    });
    expect(result.changed).toBe(true);

    const settings = JSON.parse(
      await readFile(resolve(homeDir, '.claude', 'settings.json'), 'utf-8'),
    );
    expect(settings.voiceEnabled).toBe(true);
    expect(settings.enabledPlugins['forge@user-plugins']).toBe(true);
    expect(settings.enabledPlugins['syntaur@user-plugins']).toBe(true);
  });

  it('refuses to write when settings.json is not valid JSON', async () => {
    await mkdir(resolve(homeDir, '.claude'), { recursive: true });
    await writeFile(
      resolve(homeDir, '.claude', 'settings.json'),
      'not { valid json',
      'utf-8',
    );
    await expect(
      setSyntaurPluginEnabled({ marketplaceName: 'user-plugins', enabled: true }),
    ).rejects.toThrow(/not valid JSON/);
  });

  it('reports changed=false when already in the desired state', async () => {
    await setSyntaurPluginEnabled({ marketplaceName: 'user-plugins', enabled: true });
    const result = await setSyntaurPluginEnabled({
      marketplaceName: 'user-plugins',
      enabled: true,
    });
    expect(result.changed).toBe(false);
    expect(result.previous).toBe(true);
  });
});
