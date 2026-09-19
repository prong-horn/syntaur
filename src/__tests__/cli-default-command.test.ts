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

  it('defaults to init when ~/.syntaur/config.md is missing', async () => {
    await expect(getDefaultCommandName()).resolves.toBe('init');
  });

  it('defaults to dashboard when config exists', async () => {
    const syntaurDir = resolve(homeDir, '.syntaur');
    await mkdir(syntaurDir, { recursive: true });
    await writeFile(
      resolve(syntaurDir, 'config.md'),
      '---\ndefaultProjectDir: ~/.syntaur/projects\n---\n',
    );

    await expect(getDefaultCommandName()).resolves.toBe('dashboard');
  });
});
