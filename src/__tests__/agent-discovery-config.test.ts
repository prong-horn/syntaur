import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  readConfig,
  writeAgentDiscoveryConfig,
  writeAgentsConfig,
  type AgentConfig,
} from '../utils/config.js';

describe('agent discovery + source config round-trip', () => {
  const originalHome = process.env.HOME;
  let homeDir: string;

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'syntaur-discovery-cfg-'));
    process.env.HOME = homeDir;
    await mkdir(resolve(homeDir, '.syntaur'), { recursive: true });
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    await rm(homeDir, { recursive: true, force: true });
  });

  it('defaults discovery to all-sources-on + roots [~] when unset', async () => {
    const config = await readConfig();
    expect(config.agentDiscovery).toEqual({
      claudeGlobal: true,
      claudeProject: true,
      directory: true,
      roots: ['~'],
    });
    expect(config.standaloneDefaultCwd).toBeNull();
  });

  it('round-trips discovery sources, roots, and standaloneDefaultCwd', async () => {
    await writeAgentDiscoveryConfig(
      { claudeGlobal: false, claudeProject: true, directory: false, roots: ['~', '/Users/x/projects'] },
      '/Users/x/work',
    );
    const config = await readConfig();
    expect(config.agentDiscovery).toEqual({
      claudeGlobal: false,
      claudeProject: true,
      directory: false,
      roots: ['~', '/Users/x/projects'],
    });
    expect(config.standaloneDefaultCwd).toBe('/Users/x/work');
  });

  it('preserves the agents list when writing discovery config', async () => {
    const agents: AgentConfig[] = [
      {
        id: 'my-claude',
        label: 'My Claude',
        command: 'claude',
        runner: 'claude',
        agentName: 'My Claude',
        sourceKind: 'claude-global',
        sourcePath: '/x/my-claude.md',
      },
    ];
    await writeAgentsConfig(agents);
    await writeAgentDiscoveryConfig(
      { claudeGlobal: true, claudeProject: true, directory: true, roots: ['~'] },
      null,
    );
    const config = await readConfig();
    const found = (config.agents ?? []).find((a) => a.id === 'my-claude');
    expect(found).toMatchObject({
      runner: 'claude',
      sourceKind: 'claude-global',
      sourcePath: '/x/my-claude.md',
      agentName: 'My Claude',
    });
  });

  it('round-trips runner + source* on an agent through write/read', async () => {
    const agents: AgentConfig[] = [
      {
        id: 'dir-bot',
        label: 'Dir Bot',
        command: 'pi',
        runner: 'pi',
        workdir: '/x/dir-bot',
        sourceKind: 'directory',
        sourcePath: '/x/dir-bot',
        sourceRepo: '/x/repo',
      },
    ];
    await writeAgentsConfig(agents);
    const config = await readConfig();
    const found = (config.agents ?? []).find((a) => a.id === 'dir-bot');
    expect(found).toMatchObject({
      runner: 'pi',
      sourceKind: 'directory',
      sourcePath: '/x/dir-bot',
      sourceRepo: '/x/repo',
      workdir: '/x/dir-bot',
    });
  });
});
