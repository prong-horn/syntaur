import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readlinkSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildCiLikeEnv, resolveToolPath } = require('../../scripts/test-ci-like.mjs') as {
  resolveToolPath: (tool: string, lookupPath: string, nodeExecPath?: string) => string;
  buildCiLikeEnv: (options?: { lookupPath?: string; nodeExecPath?: string }) => {
    env: Record<string, string | undefined>;
    binDir: string;
    homeDir: string;
    jqPath: string;
    npmPath: string;
    npxPath: string;
  };
};

describe('test-ci-like env', () => {
  it('buildCiLikeEnv strips PATH and home the way the release runner does', () => {
    const lookupPath = process.env.PATH ?? '';
    const jqOnLookup = execSync('command -v jq', {
      encoding: 'utf8',
      env: { ...process.env, PATH: lookupPath },
    }).trim();
    const npmOnLookup = execSync('command -v npm', {
      encoding: 'utf8',
      env: { ...process.env, PATH: lookupPath },
    }).trim();
    const npxOnLookup = execSync('command -v npx', {
      encoding: 'utf8',
      env: { ...process.env, PATH: lookupPath },
    }).trim();

    const { env, binDir, homeDir, jqPath, npmPath, npxPath } = buildCiLikeEnv({ lookupPath });
    const pathParts = env.PATH!.split(':');
    expect(pathParts).toEqual([binDir, '/usr/bin', '/bin', '/usr/sbin', '/sbin']);
    expect(existsSync(homeDir)).toBe(true);
    expect(readdirSync(homeDir)).toEqual([]);
    expect(env.SYNTAUR_HOME).toBeUndefined();
    expect(env.HOME).toBe(homeDir);

    for (const name of ['node', 'npm', 'npx', 'jq']) {
      const link = join(binDir, name);
      expect(existsSync(link)).toBe(true);
      const target = readlinkSync(link);
      expect(existsSync(target)).toBe(true);
    }
    expect(readlinkSync(join(binDir, 'jq'))).toBe(jqPath);
    expect(readlinkSync(join(binDir, 'npm'))).toBe(npmPath);
    expect(readlinkSync(join(binDir, 'npx'))).toBe(npxPath);
    expect(jqPath).toBe(jqOnLookup);
    expect(npmPath).toBe(npmOnLookup);
    expect(npxPath).toBe(npxOnLookup);

    rmSync(binDir, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
  });

  it('throws the install hint when jq is absent on lookupPath', () => {
    expect(() => buildCiLikeEnv({ lookupPath: '/var/empty' })).toThrow(/jq is required/);
  });

  it('throws when npm is absent on lookupPath and beside node', () => {
    const lookupPath = process.env.PATH ?? '';
    const jqPath = execSync('command -v jq', {
      encoding: 'utf8',
      env: { ...process.env, PATH: lookupPath },
    }).trim();
    const isolated = mkdtempSync(join(tmpdir(), 'ci-like-jq-only-'));
    symlinkSync(jqPath, join(isolated, 'jq'));
    const bareNodeDir = mkdtempSync(join(tmpdir(), 'ci-like-bare-node-'));
    symlinkSync(process.execPath, join(bareNodeDir, 'node'));
    expect(() => resolveToolPath('npm', isolated, join(bareNodeDir, 'node'))).toThrow(
      /npm is required/,
    );
    expect(() =>
      buildCiLikeEnv({ lookupPath: isolated, nodeExecPath: join(bareNodeDir, 'node') }),
    ).toThrow(/npm is required/);
    rmSync(isolated, { recursive: true, force: true });
    rmSync(bareNodeDir, { recursive: true, force: true });
  });
});
