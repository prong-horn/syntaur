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

  it('defaults to setup when ~/.syntaur/config.md is missing', () => {
    expect(getDefaultCommandName()).toBe('setup');
  });

  it('defaults to dashboard when ~/.syntaur/config.md exists', async () => {
    const syntaurDir = resolve(homeDir, '.syntaur');
    await mkdir(syntaurDir, { recursive: true });
    await writeFile(resolve(syntaurDir, 'config.md'), '---\ndefaultMissionDir: ~/.syntaur/missions\n---\n');

    expect(getDefaultCommandName()).toBe('dashboard');
  });
});
