import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { getDefaultCommandName } from '../cli-default-command.js';

describe('getDefaultCommandName', () => {
  const originalHome = process.env.HOME;
  let homeDir: string;

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'syntaur-home-'));
    process.env.HOME = homeDir;
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    await rm(homeDir, { recursive: true, force: true });
  });

  it('defaults to setup when ~/.syntaur/config.md is missing', async () => {
    await expect(getDefaultCommandName()).resolves.toBe('setup');
  });

  it('defaults to setup when config exists but onboarding is incomplete', async () => {
    const syntaurDir = resolve(homeDir, '.syntaur');
    await mkdir(syntaurDir, { recursive: true });
    await writeFile(
      resolve(syntaurDir, 'config.md'),
      '---\ndefaultProjectDir: ~/.syntaur/projects\nonboarding:\n  completed: false\n---\n',
    );

    await expect(getDefaultCommandName()).resolves.toBe('setup');
  });

  it('defaults to dashboard when onboarding is complete', async () => {
    const syntaurDir = resolve(homeDir, '.syntaur');
    await mkdir(syntaurDir, { recursive: true });
    await writeFile(
      resolve(syntaurDir, 'config.md'),
      '---\ndefaultProjectDir: ~/.syntaur/projects\nonboarding:\n  completed: true\n---\n',
    );

    await expect(getDefaultCommandName()).resolves.toBe('dashboard');
  });

  it('treats legacy installs with project content as complete', async () => {
    const syntaurDir = resolve(homeDir, '.syntaur');
    const projectsDir = resolve(syntaurDir, 'projects');
    await mkdir(resolve(projectsDir, 'existing-project'), { recursive: true });
    await writeFile(
      resolve(syntaurDir, 'config.md'),
      `---\ndefaultProjectDir: ${projectsDir}\n---\n`,
    );

    await expect(getDefaultCommandName()).resolves.toBe('dashboard');
  });
});
