import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { readConfig, updateIntegrationConfig } from '../utils/config.js';

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

  it('ignores a legacy workspaceVisibility block without error', async () => {
    const configPath = resolve(homeDir, '.syntaur', 'config.md');
    await writeFile(
      configPath,
      '---\nversion: "2.0"\ndefaultProjectDir: ~/.syntaur/projects\nworkspaceVisibility:\n  hidden:\n    - "old-workspace"\n---\n',
    );

    const config = await readConfig();

    expect(config.defaultProjectDir).toBe(resolve(homeDir, '.syntaur', 'projects'));
    expect('workspaceVisibility' in config).toBe(false);
  });

  it('ignores a legacy backup block without error', async () => {
    const configPath = resolve(homeDir, '.syntaur', 'config.md');
    await writeFile(
      configPath,
      '---\nversion: "1.0"\ndefaultProjectDir: ~/.syntaur/projects\nbackup:\n  repo: null\n  categories: projects, playbooks\n  lastBackup: null\n  lastRestore: null\n---\n',
    );

    const config = await readConfig();

    expect(config.defaultProjectDir).toBe(resolve(homeDir, '.syntaur', 'projects'));
    expect('backup' in config).toBe(false);
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

  it('updates integration keys without deleting legacy on-disk blocks or body content', async () => {
    const configPath = resolve(homeDir, '.syntaur', 'config.md');
    await writeFile(
      configPath,
      '---\nversion: "2.0"\ndefaultProjectDir: ~/projects\nstatuses:\n  definitions:\n    - id: todo\n      label: Todo\n---\nCustom config notes.\n',
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

  it('always returns null statuses/workflows even when legacy blocks exist on disk', async () => {
    const configPath = resolve(homeDir, '.syntaur', 'config.md');
    await writeFile(
      configPath,
      '---\nversion: "2.0"\ndefaultProjectDir: ~/projects\ndefaultWorkflow: feature\nstatuses:\n  definitions:\n    - id: todo\n      label: Todo\nworkflows:\n  feature:\n    label: Feature\n---\n',
    );

    const config = await readConfig();

    expect(config.statuses).toBeNull();
    expect(config.workflows).toBeNull();
    expect(config.defaultWorkflow).toBe('feature');
  });
});
