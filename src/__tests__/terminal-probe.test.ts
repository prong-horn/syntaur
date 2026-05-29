import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Force `mdfind` to return nothing (status 0 + empty stdout) — the
// non-indexed/launchd case that produces the Warp false-negative. The probe
// must then fall back to checking the .app bundle on disk.
vi.mock('node:child_process', () => ({
  spawnSync: vi.fn(() => ({ status: 0, stdout: '', stderr: '' })),
}));

import {
  probeTerminalInstalled,
  findAppBundle,
} from '../utils/terminal-probe.js';

describe('probeTerminalInstalled — .app fallback when mdfind is empty', () => {
  let appsDir: string;

  beforeEach(async () => {
    appsDir = await mkdtemp(join(tmpdir(), 'syntaur-apps-'));
  });
  afterEach(async () => {
    await rm(appsDir, { recursive: true, force: true });
  });

  it('returns ok with the .app path when mdfind is empty but the bundle exists on disk', async () => {
    await mkdir(join(appsDir, 'Warp.app'), { recursive: true });

    const result = probeTerminalInstalled('warp', {
      applicationsDirs: [appsDir],
    });

    expect(result).toEqual({ ok: true, foundPath: join(appsDir, 'Warp.app') });
  });

  it('returns not-installed when mdfind is empty and no bundle exists', () => {
    const result = probeTerminalInstalled('warp', {
      applicationsDirs: [appsDir],
    });

    expect(result).toEqual({ ok: false, reason: 'not-installed' });
  });

  it('findAppBundle locates the bundle in the given dirs, else null', async () => {
    await mkdir(join(appsDir, 'Warp.app'), { recursive: true });

    expect(findAppBundle('warp', [appsDir])).toBe(join(appsDir, 'Warp.app'));
    expect(findAppBundle('warp', [join(appsDir, 'nonexistent')])).toBeNull();
  });
});
