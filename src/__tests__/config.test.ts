import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { readConfig } from '../utils/config.js';
import { runChecks } from '../utils/doctor/index.js';

describe('config legacy install keys', () => {
  const originalHome = process.env.HOME;
  let homeDir: string;

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'syntaur-config-'));
    process.env.HOME = homeDir;
    await mkdir(resolve(homeDir, '.syntaur', 'projects'), { recursive: true });
    await mkdir(resolve(homeDir, '.syntaur', 'playbooks'), { recursive: true });
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    vi.restoreAllMocks();
    await rm(homeDir, { recursive: true, force: true });
  });

  it('loads a legacy config with integrations and onboarding blocks', async () => {
    const configPath = resolve(homeDir, '.syntaur', 'config.md');
    await writeFile(
      configPath,
      `---\nversion: "1.0"\ndefaultProjectDir: ${resolve(homeDir, '.syntaur', 'projects')}\nintegrations:\n  claudePluginDir: ~/.claude/plugins/syntaur\n  codexPluginDir: ~/plugins/syntaur\n  codexMarketplacePath: ~/.agents/plugins/marketplace.json\n  installedAgents.pi: global\nonboarding:\n  completed: true\n---\n`,
    );

    const config = await readConfig();
    expect(config.defaultProjectDir).toBe(resolve(homeDir, '.syntaur', 'projects'));
    expect('integrations' in config).toBe(false);
    expect('onboarding' in config).toBe(false);

    const report = await runChecks();
    const configCheck = report.checks.find((c) => c.id === 'env.config-valid');
    expect(configCheck?.status).toBe('pass');
  });

  it('drops legacy install blocks on first read migration', async () => {
    const configPath = resolve(homeDir, '.syntaur', 'config.md');
    const before = `---\nversion: "1.0"\ndefaultProjectDir: ${resolve(homeDir, '.syntaur', 'projects')}\nintegrations:\n  claudePluginDir: /tmp/x\nonboarding:\n  completed: false\n---\n`;
    await writeFile(configPath, before, 'utf-8');

    await readConfig();
    const after = await readFile(configPath, 'utf-8');
    expect(after).not.toMatch(/^\s*integrations:/m);
    expect(after).not.toMatch(/^\s*onboarding:/m);
    expect(after).toContain('defaultProjectDir:');
  });

  it('fresh init config has no integrations or onboarding blocks', async () => {
    const configPath = resolve(homeDir, '.syntaur', 'config.md');
    await writeFile(
      configPath,
      `---\nversion: "1.0"\ndefaultProjectDir: ${resolve(homeDir, '.syntaur', 'projects')}\nagentDefaults:\n  trustLevel: medium\n  autoApprove: false\nsession:\n  idleSweepHours: 6\n---\n`,
    );
    const config = await readConfig();
    const raw = await readFile(configPath, 'utf-8');
    expect(raw).not.toMatch(/^\s*integrations:/m);
    expect(raw).not.toMatch(/^\s*onboarding:/m);
    expect(config.defaultProjectDir).toBe(resolve(homeDir, '.syntaur', 'projects'));
    await readConfig();
    expect(await readFile(configPath, 'utf-8')).toBe(raw);
  });
});
