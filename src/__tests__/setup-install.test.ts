import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { installPluginCommand } from '../commands/install-plugin.js';
import { installCodexPluginCommand } from '../commands/install-codex-plugin.js';
import { setupCommand } from '../commands/setup.js';
import { uninstallCommand } from '../commands/uninstall.js';
import { buildMarketplaceSourcePath, installManagedPlugin } from '../utils/install.js';

const execFileAsync = promisify(execFile);

describe('setup and install flows', () => {
  const originalHome = process.env.HOME;
  let homeDir: string;
  let stdinTty: boolean | undefined;
  let stdoutTty: boolean | undefined;

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'syntaur-home-'));
    process.env.HOME = homeDir;
    stdinTty = process.stdin.isTTY;
    stdoutTty = process.stdout.isTTY;
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    Object.defineProperty(process.stdin, 'isTTY', { value: stdinTty, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: stdoutTty, configurable: true });
    await rm(homeDir, { recursive: true, force: true });
  });

  it('setup --yes initializes data without installing plugins', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });

    await setupCommand({ yes: true });

    const configPath = resolve(homeDir, '.syntaur', 'config.md');
    expect(await readFile(configPath, 'utf-8')).toContain('defaultMissionDir');
  });

  it('non-interactive setup without flags fails with guidance', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });

    await expect(setupCommand({})).rejects.toThrow('Non-interactive setup requires --yes');
  });

  it('installs the Claude plugin by copying files by default', async () => {
    await installPluginCommand({});

    const targetDir = resolve(homeDir, '.claude', 'plugins', 'syntaur');
    const info = await lstat(targetDir);
    expect(info.isSymbolicLink()).toBe(false);
    expect(await readFile(resolve(targetDir, '.syntaur-install.json'), 'utf-8')).toContain('"pluginKind": "claude"');
    expect(await readFile(resolve(homeDir, '.syntaur', 'config.md'), 'utf-8')).toContain(`claudePluginDir: ${targetDir}`);
  });

  it('installs the Codex plugin and marketplace entry by copy', async () => {
    await installCodexPluginCommand({});

    const targetDir = resolve(homeDir, 'plugins', 'syntaur');
    const marketplacePath = resolve(homeDir, '.agents', 'plugins', 'marketplace.json');
    expect((await lstat(targetDir)).isSymbolicLink()).toBe(false);
    expect(await readFile(resolve(targetDir, '.syntaur-install.json'), 'utf-8')).toContain('"pluginKind": "codex"');
    expect(await readFile(marketplacePath, 'utf-8')).toContain('"name": "syntaur"');
    expect(await readFile(resolve(homeDir, '.syntaur', 'config.md'), 'utf-8')).toContain(`codexPluginDir: ${targetDir}`);
    expect(await readFile(resolve(homeDir, '.syntaur', 'config.md'), 'utf-8')).toContain(`codexMarketplacePath: ${marketplacePath}`);
  });

  it('supports explicit link installs for repo-local development', async () => {
    await installPluginCommand({ link: true });

    const targetDir = resolve(homeDir, '.claude', 'plugins', 'syntaur');
    expect((await lstat(targetDir)).isSymbolicLink()).toBe(true);
  });

  it('installs plugins at explicit custom locations and persists them in config', async () => {
    const claudeTargetDir = resolve(homeDir, 'custom-claude', 'syntaur');
    const codexTargetDir = resolve(homeDir, 'custom-codex', 'syntaur');
    const marketplacePath = resolve(homeDir, 'custom-config', 'marketplace.json');

    await installPluginCommand({ targetDir: claudeTargetDir });
    await installCodexPluginCommand({
      targetDir: codexTargetDir,
      marketplacePath,
    });

    expect((await lstat(claudeTargetDir)).isDirectory()).toBe(true);
    expect((await lstat(codexTargetDir)).isDirectory()).toBe(true);
    const marketplaceContent = await readFile(marketplacePath, 'utf-8');
    expect(marketplaceContent).toContain(buildMarketplaceSourcePath(codexTargetDir, marketplacePath));

    const configContent = await readFile(resolve(homeDir, '.syntaur', 'config.md'), 'utf-8');
    expect(configContent).toContain(`claudePluginDir: ${claudeTargetDir}`);
    expect(configContent).toContain(`codexPluginDir: ${codexTargetDir}`);
    expect(configContent).toContain(`codexMarketplacePath: ${marketplacePath}`);
  });

  it('treats repeated link installs as current unless --force is used', async () => {
    const first = await installManagedPlugin({ pluginKind: 'claude', link: true });
    const second = await installManagedPlugin({ pluginKind: 'claude', link: true });
    const forced = await installManagedPlugin({ pluginKind: 'claude', link: true, force: true });

    expect(first.changed).toBe(true);
    expect(second.changed).toBe(false);
    expect(forced.changed).toBe(true);
  });

  it('migrates a managed Claude install when the target path changes', async () => {
    const originalTarget = resolve(homeDir, '.claude', 'plugins', 'syntaur');
    const newTarget = resolve(homeDir, 'claude-custom', 'syntaur');

    await installPluginCommand({});
    await installPluginCommand({ targetDir: newTarget });

    await expect(lstat(originalTarget)).rejects.toThrow();
    expect((await lstat(newTarget)).isDirectory()).toBe(true);
    expect(await readFile(resolve(homeDir, '.syntaur', 'config.md'), 'utf-8')).toContain(`claudePluginDir: ${newTarget}`);
  });

  it('migrates a managed Codex install and marketplace entry when paths change', async () => {
    const originalTarget = resolve(homeDir, 'plugins', 'syntaur');
    const originalMarketplace = resolve(homeDir, '.agents', 'plugins', 'marketplace.json');
    const newTarget = resolve(homeDir, 'codex-custom', 'syntaur');
    const newMarketplace = resolve(homeDir, 'codex-config', 'marketplace.json');

    await installCodexPluginCommand({});
    await installCodexPluginCommand({
      targetDir: newTarget,
      marketplacePath: newMarketplace,
    });

    await expect(lstat(originalTarget)).rejects.toThrow();
    await expect(readFile(originalMarketplace, 'utf-8')).rejects.toThrow();
    expect(await readFile(newMarketplace, 'utf-8')).toContain(buildMarketplaceSourcePath(newTarget, newMarketplace));
    expect(await readFile(resolve(homeDir, '.syntaur', 'config.md'), 'utf-8')).toContain(`codexMarketplacePath: ${newMarketplace}`);
  });

  it('default uninstall removes plugins but keeps ~/.syntaur data', async () => {
    await mkdir(resolve(homeDir, '.syntaur'), { recursive: true });
    await writeFile(resolve(homeDir, '.syntaur', 'config.md'), '---\ndefaultMissionDir: ~/.syntaur/missions\n---\n');
    await installPluginCommand({});
    await installCodexPluginCommand({});

    await uninstallCommand({ yes: true });

    await expect(lstat(resolve(homeDir, '.claude', 'plugins', 'syntaur'))).rejects.toThrow();
    await expect(lstat(resolve(homeDir, 'plugins', 'syntaur'))).rejects.toThrow();
    expect(await readFile(resolve(homeDir, '.syntaur', 'config.md'), 'utf-8')).toContain('defaultMissionDir');
  });

  it('uninstall removes plugins from remembered custom locations', async () => {
    const claudeTarget = resolve(homeDir, 'custom-claude', 'syntaur');
    const codexTarget = resolve(homeDir, 'custom-codex', 'syntaur');
    const marketplacePath = resolve(homeDir, 'custom-config', 'marketplace.json');

    await installPluginCommand({ targetDir: claudeTarget });
    await installCodexPluginCommand({
      targetDir: codexTarget,
      marketplacePath,
    });

    await uninstallCommand({ yes: true });

    await expect(lstat(claudeTarget)).rejects.toThrow();
    await expect(lstat(codexTarget)).rejects.toThrow();
    await expect(lstat(marketplacePath)).rejects.toThrow();
    expect(await readFile(resolve(homeDir, '.syntaur', 'config.md'), 'utf-8')).toContain(`claudePluginDir: ${claudeTarget}`);
  });

  it('uninstall --all removes ~/.syntaur data and marketplace state', async () => {
    await mkdir(resolve(homeDir, '.syntaur'), { recursive: true });
    await writeFile(
      resolve(homeDir, '.syntaur', 'config.md'),
      '---\ndefaultMissionDir: /tmp/custom-missions\n---\n',
    );
    await installCodexPluginCommand({});

    await uninstallCommand({ all: true, yes: true });

    await expect(lstat(resolve(homeDir, '.syntaur'))).rejects.toThrow();
    await expect(lstat(resolve(homeDir, '.agents', 'plugins', 'marketplace.json'))).rejects.toThrow();
  });

  it('npm pack dry-run includes packaged playbooks and plugin assets', async () => {
    const { stdout } = await execFileAsync('npm', ['pack', '--json', '--dry-run'], {
      cwd: process.cwd(),
    });
    const result = JSON.parse(stdout) as Array<{ files: Array<{ path: string }> }>;
    const files = result[0].files.map((file) => file.path);

    expect(files).toContain('examples/playbooks/commit-discipline.md');
    expect(files).toContain('plugin/.claude-plugin/plugin.json');
    expect(files).toContain('plugins/syntaur/.codex-plugin/plugin.json');
  });
});
