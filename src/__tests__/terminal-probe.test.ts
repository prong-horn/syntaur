import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

// Default mock: `mdfind` returns nothing (status 0 + empty stdout) — the
// non-indexed/launchd case that produces the Warp false-negative. Individual
// tests can override the return value (e.g. a non-zero exit). The probe must
// then fall back to checking the .app bundle on disk.
vi.mock('node:child_process', () => ({
  spawnSync: vi.fn(() => ({ status: 0, stdout: '', stderr: '' })),
}));

import {
  probeTerminalInstalled,
  findAppBundle,
  resolveCmuxCli,
} from '../utils/terminal-probe.js';

describe('probeTerminalInstalled — .app fallback when mdfind misses', () => {
  let appsDir: string;

  beforeEach(async () => {
    appsDir = await mkdtemp(join(tmpdir(), 'syntaur-apps-'));
    vi.mocked(spawnSync).mockReturnValue({
      status: 0,
      stdout: '',
      stderr: '',
    } as unknown as ReturnType<typeof spawnSync>);
  });
  afterEach(async () => {
    await rm(appsDir, { recursive: true, force: true });
  });

  it('returns ok with the .app path when mdfind is empty but the bundle exists on disk', async () => {
    await mkdir(join(appsDir, 'Warp.app'), { recursive: true });

    const result = probeTerminalInstalled('warp', {
      applicationsDirsOverride: [appsDir],
    });

    expect(result).toEqual({ ok: true, foundPath: join(appsDir, 'Warp.app') });
  });

  it('falls back to the .app bundle even when mdfind exits non-zero', async () => {
    await mkdir(join(appsDir, 'Warp.app'), { recursive: true });
    vi.mocked(spawnSync).mockReturnValue({
      status: 1,
      stdout: '',
      stderr: 'mdfind: some error',
    } as unknown as ReturnType<typeof spawnSync>);

    const result = probeTerminalInstalled('warp', {
      applicationsDirsOverride: [appsDir],
    });

    expect(result).toEqual({ ok: true, foundPath: join(appsDir, 'Warp.app') });
  });

  it('returns not-installed when mdfind misses and no bundle exists', () => {
    const result = probeTerminalInstalled('warp', {
      applicationsDirsOverride: [appsDir],
    });

    expect(result).toEqual({ ok: false, reason: 'not-installed' });
  });

  it('findAppBundle locates the bundle in the given dirs, else null', async () => {
    await mkdir(join(appsDir, 'Warp.app'), { recursive: true });

    expect(findAppBundle('warp', [appsDir])).toBe(join(appsDir, 'Warp.app'));
    expect(findAppBundle('warp', [join(appsDir, 'nonexistent')])).toBeNull();
  });
});

describe('resolveCmuxCli + probeTerminalInstalled("cmux")', () => {
  let appsDir: string;

  // Stage a fake cmux.app whose bundled CLI exists on disk, and return the
  // absolute CLI path the resolver should return.
  async function stageCmuxBundle(dir: string): Promise<string> {
    const cliPath = join(dir, 'cmux.app', 'Contents', 'Resources', 'bin', 'cmux');
    await mkdir(join(dir, 'cmux.app', 'Contents', 'Resources', 'bin'), {
      recursive: true,
    });
    await writeFile(cliPath, '#!/bin/sh\nexit 0\n');
    return cliPath;
  }

  function spawnArgs() {
    // Every arg list passed to the mocked spawnSync this test (first positional
    // is the command name: 'which', 'mdfind', ...).
    return vi.mocked(spawnSync).mock.calls.map((call) => call[0]);
  }

  beforeEach(async () => {
    appsDir = await mkdtemp(join(tmpdir(), 'syntaur-cmux-apps-'));
    // vitest does not clearMocks (see vitest.config.ts), so prior tests'
    // spawnSync calls would pollute the call-history assertions below.
    vi.mocked(spawnSync).mockClear();
    vi.mocked(spawnSync).mockReturnValue({
      status: 0,
      stdout: '',
      stderr: '',
    } as unknown as ReturnType<typeof spawnSync>);
  });
  afterEach(async () => {
    await rm(appsDir, { recursive: true, force: true });
  });

  it('resolveCmuxCli returns the absolute bundle CLI path without calling `which`', async () => {
    const cliPath = await stageCmuxBundle(appsDir);

    expect(resolveCmuxCli([appsDir])).toBe(cliPath);
    // The bundle CLI was found, so `which` must NOT be consulted.
    expect(spawnArgs()).not.toContain('which');
  });

  it('resolveCmuxCli falls back to `which cmux` when no bundle is present', () => {
    vi.mocked(spawnSync).mockReturnValue({
      status: 0,
      stdout: '/usr/local/bin/cmux\n',
      stderr: '',
    } as unknown as ReturnType<typeof spawnSync>);

    expect(resolveCmuxCli([appsDir])).toBe('/usr/local/bin/cmux');
    expect(spawnArgs()).toContain('which');
  });

  it('resolveCmuxCli returns null when neither the bundle nor `which` resolves', () => {
    // Default mock: `which` exits 0 with empty stdout → unresolved.
    expect(resolveCmuxCli([appsDir])).toBeNull();
  });

  it('probeTerminalInstalled("cmux") is ok with the bundle CLI and never calls mdfind', async () => {
    const cliPath = await stageCmuxBundle(appsDir);

    const result = probeTerminalInstalled('cmux', {
      applicationsDirsOverride: [appsDir],
    });

    expect(result).toEqual({ ok: true, foundPath: cliPath });
    // cmux must take the resolver path, NOT the generic bundle-id mdfind path.
    expect(spawnArgs()).not.toContain('mdfind');
  });

  it('probeTerminalInstalled("cmux") reports not-installed when bundle absent and `which` misses', () => {
    const result = probeTerminalInstalled('cmux', {
      applicationsDirsOverride: [appsDir],
    });

    expect(result).toEqual({ ok: false, reason: 'not-installed' });
    expect(spawnArgs()).not.toContain('mdfind');
  });
});
