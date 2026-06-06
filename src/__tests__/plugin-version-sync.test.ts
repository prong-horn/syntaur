import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { syncPluginVersion, PLUGIN_MANIFESTS } from '../../scripts/sync-plugin-version.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

async function readVersion(path: string): Promise<string> {
  return JSON.parse(await readFile(path, 'utf8')).version;
}

describe('plugin manifests are version-stamped from package.json (drift gate)', () => {
  it('every plugin manifest version equals package.json.version', async () => {
    const pkgVersion = JSON.parse(await readFile(resolve(repoRoot, 'package.json'), 'utf8')).version;
    for (const rel of PLUGIN_MANIFESTS) {
      expect(await readVersion(resolve(repoRoot, rel)), `${rel} drifted from package.json`).toBe(pkgVersion);
    }
  });

  it('covers all three known manifests', () => {
    expect([...PLUGIN_MANIFESTS].sort()).toEqual([
      '.claude-plugin/plugin.json',
      'platforms/claude-code/.claude-plugin/plugin.json',
      'platforms/codex/.codex-plugin/plugin.json',
    ]);
  });
});

describe('syncPluginVersion (pure)', () => {
  let sandbox: string;

  async function seed(pkgVersion: string, manifestVersion: string): Promise<void> {
    await writeFile(resolve(sandbox, 'package.json'), JSON.stringify({ name: 'syntaur', version: pkgVersion }), 'utf8');
    for (const rel of PLUGIN_MANIFESTS) {
      const path = resolve(sandbox, rel);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, `${JSON.stringify({ name: 'syntaur', version: manifestVersion, other: 'keep' }, null, 2)}\n`, 'utf8');
    }
  }

  beforeEach(async () => {
    sandbox = await mkdtemp(join(tmpdir(), 'syntaur-pvsync-'));
  });
  afterEach(async () => {
    await rm(sandbox, { recursive: true, force: true });
  });

  it('rewrites ALL three manifests and preserves other fields', async () => {
    await seed('1.2.3', '0.0.0');
    const res = await syncPluginVersion({ repoRoot: sandbox });
    expect(res.version).toBe('1.2.3');
    expect([...res.changed].sort()).toEqual([...PLUGIN_MANIFESTS].sort());
    for (const rel of PLUGIN_MANIFESTS) {
      const m = JSON.parse(await readFile(resolve(sandbox, rel), 'utf8'));
      expect(m.version).toBe('1.2.3');
      expect(m.other).toBe('keep'); // other fields untouched
    }
  });

  it('is idempotent (second run changes nothing)', async () => {
    await seed('1.2.3', '0.0.0');
    await syncPluginVersion({ repoRoot: sandbox });
    const second = await syncPluginVersion({ repoRoot: sandbox });
    expect(second.changed).toEqual([]);
  });

  it('--check reports drift WITHOUT mutating files', async () => {
    await seed('1.2.3', '0.0.0');
    const res = await syncPluginVersion({ repoRoot: sandbox, check: true });
    expect([...res.drifted].sort()).toEqual([...PLUGIN_MANIFESTS].sort());
    // files untouched
    for (const rel of PLUGIN_MANIFESTS) {
      expect(await readVersion(resolve(sandbox, rel))).toBe('0.0.0');
    }
  });

  it('--check is clean when already in sync', async () => {
    await seed('1.2.3', '1.2.3');
    const res = await syncPluginVersion({ repoRoot: sandbox, check: true });
    expect(res.drifted).toEqual([]);
  });

  it('throws when package.json has no version', async () => {
    await seed('1.2.3', '0.0.0');
    await writeFile(resolve(sandbox, 'package.json'), JSON.stringify({ name: 'x' }), 'utf8');
    await expect(syncPluginVersion({ repoRoot: sandbox })).rejects.toThrow(/version/);
  });
});
