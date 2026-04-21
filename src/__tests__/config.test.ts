import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { readConfig, updateIntegrationConfig, writeStatusConfig } from '../utils/config.js';

describe('config integrations', () => {
  const originalHome = process.env.HOME;
  let homeDir: string;

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'syntaur-config-'));
    process.env.HOME = homeDir;
    await mkdir(resolve(homeDir, '.syntaur'), { recursive: true });
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    vi.restoreAllMocks();
    await rm(homeDir, { recursive: true, force: true });
  });

  it('reads optional integration paths and expands home-relative values', async () => {
    const configPath = resolve(homeDir, '.syntaur', 'config.md');
    await writeFile(
      configPath,
      '---\nversion: "1.0"\ndefaultProjectDir: ~/.syntaur/projects\nintegrations:\n  claudePluginDir: ~/.claude/plugins/syntaur\n  codexPluginDir: ~/plugins/syntaur\n  codexMarketplacePath: ~/.agents/plugins/marketplace.json\n---\n',
    );

    const config = await readConfig();

    expect(config.integrations.claudePluginDir).toBe(resolve(homeDir, '.claude', 'plugins', 'syntaur'));
    expect(config.integrations.codexPluginDir).toBe(resolve(homeDir, 'plugins', 'syntaur'));
    expect(config.integrations.codexMarketplacePath).toBe(resolve(homeDir, '.agents', 'plugins', 'marketplace.json'));
  });

  it('ignores malformed relative integration paths', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const configPath = resolve(homeDir, '.syntaur', 'config.md');
    await writeFile(
      configPath,
      '---\nversion: "1.0"\ndefaultProjectDir: ~/.syntaur/projects\nintegrations:\n  claudePluginDir: relative/path\n---\n',
    );

    const config = await readConfig();

    expect(config.integrations.claudePluginDir).toBeNull();
    expect(warnSpy).toHaveBeenCalled();
  });

  it('updates integration keys without deleting existing status config or body content', async () => {
    await writeStatusConfig({
      statuses: [
        { id: 'todo', label: 'Todo' },
        { id: 'done', label: 'Done', terminal: true },
      ],
      order: ['todo', 'done'],
      transitions: [],
    });
    const configPath = resolve(homeDir, '.syntaur', 'config.md');
    await writeFile(
      configPath,
      `${await readFile(configPath, 'utf-8')}\nCustom config notes.\n`,
    );

    await updateIntegrationConfig({
      claudePluginDir: resolve(homeDir, '.claude', 'plugins', 'syntaur'),
      codexPluginDir: resolve(homeDir, 'plugins', 'syntaur'),
    });

    const content = await readFile(configPath, 'utf-8');
    expect(content).toContain('integrations:');
    expect(content).toContain('statuses:');
    expect(content).toContain('Custom config notes.');
  });
});
