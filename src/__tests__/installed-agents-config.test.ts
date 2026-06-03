import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { readConfig, updateIntegrationConfig } from '../utils/config.js';

describe('integrations.installedAgents config', () => {
  const originalHome = process.env.HOME;
  const originalSyntaurHome = process.env.SYNTAUR_HOME;
  let homeDir: string;

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'syntaur-installed-'));
    process.env.HOME = homeDir;
    delete process.env.SYNTAUR_HOME;
    await mkdir(resolve(homeDir, '.syntaur'), { recursive: true });
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    if (originalSyntaurHome === undefined) delete process.env.SYNTAUR_HOME;
    else process.env.SYNTAUR_HOME = originalSyntaurHome;
    await rm(homeDir, { recursive: true, force: true });
  });

  it('is undefined when unset', async () => {
    const cfg = await readConfig();
    expect(cfg.integrations.installedAgents).toBeUndefined();
  });

  it('round-trips installedAgents through update/read', async () => {
    await updateIntegrationConfig({
      installedAgents: { pi: { scope: 'global' }, hermes: { scope: 'project' } },
    });
    const cfg = await readConfig();
    expect(cfg.integrations.installedAgents).toEqual({
      pi: { scope: 'global' },
      hermes: { scope: 'project' },
    });
  });

  it('preserves existing scalar integration fields', async () => {
    await updateIntegrationConfig({ installedAgents: { pi: { scope: 'global' } } });
    const cfg = await readConfig();
    expect(cfg.integrations.claudePluginDir).toBeNull();
    expect(cfg.integrations.installedAgents).toEqual({ pi: { scope: 'global' } });
  });

  it('shallow-merge replaces the whole installedAgents map (matches crossAgentInstall pre-merge)', async () => {
    await updateIntegrationConfig({ installedAgents: { pi: { scope: 'global' } } });
    await updateIntegrationConfig({ installedAgents: { openclaw: { scope: 'global' } } });
    const cfg = await readConfig();
    expect(cfg.integrations.installedAgents).toEqual({ openclaw: { scope: 'global' } });
  });
});
