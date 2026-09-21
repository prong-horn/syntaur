import { describe, expect, it } from 'vitest';
import { existsSync, readlinkSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildCiLikeEnv } = require('../../scripts/test-ci-like.mjs') as {
  buildCiLikeEnv: (options?: { lookupPath?: string }) => {
    env: Record<string, string | undefined>;
    binDir: string;
    homeDir: string;
    jqPath: string;
  };
};

describe('test-ci-like env', () => {
  it('buildCiLikeEnv strips PATH and home the way the release runner does', () => {
    const lookupPath = process.env.PATH ?? '';
    const jqOnLookup = execSync('command -v jq', {
      encoding: 'utf8',
      env: { ...process.env, PATH: lookupPath },
    }).trim();

    const { env, binDir, homeDir, jqPath } = buildCiLikeEnv({ lookupPath });
    const pathParts = env.PATH!.split(':');
    expect(pathParts).toEqual([binDir, '/usr/bin', '/bin', '/usr/sbin', '/sbin']);
    expect(existsSync(homeDir)).toBe(true);
    expect(readdirSync(homeDir)).toEqual([]);
    expect(env.SYNTAUR_HOME).toBeUndefined();
    expect(env.HOME).toBe(homeDir);

    for (const name of ['node', 'npm', 'npx', 'jq']) {
      expect(existsSync(join(binDir, name))).toBe(true);
    }
    expect(readlinkSync(join(binDir, 'jq'))).toBe(jqPath);
    expect(jqPath).toBe(jqOnLookup);

    rmSync(binDir, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
  });

  it('throws the install hint when jq is absent on lookupPath', () => {
    expect(() => buildCiLikeEnv({ lookupPath: '/var/empty' })).toThrow(/jq is required/);
  });
});
