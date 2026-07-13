import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SyntaurError } from '../../errors.js';
import {
  ensureDir0700,
  guardSunPath,
  ptySockPath,
  runtimeBaseDir,
} from '../paths.js';

describe('runtimeBaseDir', () => {
  const original = process.env.SYNTAUR_RUNTIME_DIR;
  afterEach(() => {
    if (original === undefined) delete process.env.SYNTAUR_RUNTIME_DIR;
    else process.env.SYNTAUR_RUNTIME_DIR = original;
  });

  it('honors SYNTAUR_RUNTIME_DIR', () => {
    process.env.SYNTAUR_RUNTIME_DIR = '/tmp/custom-runtime';
    expect(runtimeBaseDir()).toBe('/tmp/custom-runtime');
  });

  it('defaults to /tmp/syntaur-<uid>', () => {
    delete process.env.SYNTAUR_RUNTIME_DIR;
    expect(runtimeBaseDir()).toMatch(/^\/tmp\/syntaur-\d+$/);
  });
});

describe('guardSunPath', () => {
  it('returns the path unchanged when within the limit', () => {
    const p = '/tmp/syntaur-501/abc/control.sock';
    expect(guardSunPath(p)).toBe(p);
  });

  it('throws a SyntaurError with actionable remediation when too long', () => {
    const longPath = `/tmp/${'x'.repeat(120)}/control.sock`;
    let thrown: unknown;
    try {
      guardSunPath(longPath);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(SyntaurError);
    expect((thrown as SyntaurError).remediation).toContain('SYNTAUR_RUNTIME_DIR');
  });

  it('surfaces the overflow through the socket-path builders', () => {
    process.env.SYNTAUR_RUNTIME_DIR = `/tmp/${'y'.repeat(120)}`;
    try {
      expect(() => ptySockPath('daemon', 'short')).toThrow(SyntaurError);
    } finally {
      delete process.env.SYNTAUR_RUNTIME_DIR;
    }
  });
});

describe('ensureDir0700', () => {
  let base: string;
  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), 'syntaur-paths-'));
  });
  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it('creates nested dirs with mode 0700', async () => {
    const nested = join(base, 'daemon-abc', 'pty');
    ensureDir0700(nested);
    const mode = (await stat(nested)).mode & 0o777;
    expect(mode).toBe(0o700);
  });
});
