import { describe, expect, it } from 'vitest';
import {
  updateCommand,
  detectPackageManager,
  pmUpdateCommand,
  defaultResolveFreshBin,
  bunGlobalNodeModulesDir,
  type UpdateRunner,
  type UpdateDeps,
  type UpdateOptions,
} from '../commands/update.js';
import type { InstallKind } from '../launch/index.js';

const SCRIPT_URL = 'file:///opt/x/bin/syntaur.js';

interface RunnerCall {
  cmd: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
}

function recordingRunner(
  results: Array<{ code?: number; stdout?: string; stderr?: string; error?: Error }> = [],
): { runner: UpdateRunner; calls: RunnerCall[] } {
  const calls: RunnerCall[] = [];
  let i = 0;
  const runner: UpdateRunner = async (cmd, args, opts) => {
    calls.push({ cmd, args, env: opts?.env });
    const r = results[i++] ?? {};
    return { code: r.code ?? 0, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error };
  };
  return { runner, calls };
}

function makeDeps(
  over: Partial<UpdateDeps> & { kind?: InstallKind; old?: string; latest?: string | null } = {},
): { deps: UpdateDeps; logs: string[]; calls: RunnerCall[] } {
  const logs: string[] = [];
  const rec = over.runner ? { runner: over.runner, calls: [] as RunnerCall[] } : recordingRunner();
  const deps: UpdateDeps = {
    runner: rec.runner,
    detectKind: () => over.kind ?? 'global',
    readOldVersion: over.readOldVersion ?? (async () => over.old ?? '0.1.0'),
    fetchLatest: async () => (over.latest === undefined ? '9.9.9' : over.latest),
    getManagedDir: async () => over.getManagedDir ? (await over.getManagedDir('claude')) : '/home/u/.claude/plugins/syntaur',
    // Default: fail to resolve a fresh bin → refresh falls back to PATH `syntaur`
    // (keeps refresh call-counts clean). Override per-test to assert resolution.
    resolveFreshBin: over.resolveFreshBin ?? (async () => null),
    env: over.env ?? {},
    log: (m) => logs.push(m),
  };
  return { deps, logs, calls: rec.calls };
}

function run(options: Partial<UpdateOptions>, deps: UpdateDeps): Promise<void> {
  return updateCommand({ scriptUrl: SCRIPT_URL, ...options }, deps);
}

describe('pmUpdateCommand', () => {
  it('builds the correct global-update command per PM (latest)', () => {
    expect(pmUpdateCommand('npm', '9.9.9')).toEqual({ cmd: 'npm', args: ['install', '-g', 'syntaur@9.9.9'] });
    expect(pmUpdateCommand('pnpm', '9.9.9')).toEqual({ cmd: 'pnpm', args: ['add', '-g', 'syntaur@9.9.9'] });
    expect(pmUpdateCommand('yarn', '9.9.9')).toEqual({ cmd: 'yarn', args: ['global', 'add', 'syntaur@9.9.9'] });
    expect(pmUpdateCommand('bun', '9.9.9')).toEqual({ cmd: 'bun', args: ['add', '-g', 'syntaur@9.9.9'] });
  });
  it('pins an exact version', () => {
    expect(pmUpdateCommand('pnpm', '0.24.0')).toEqual({ cmd: 'pnpm', args: ['add', '-g', 'syntaur@0.24.0'] });
  });
});

describe('detectPackageManager', () => {
  it('prefers npm_config_user_agent', () => {
    expect(detectPackageManager('/x', { npm_config_user_agent: 'pnpm/8.0.0 npm/? node/v20' })).toBe('pnpm');
    expect(detectPackageManager('/x', { npm_config_user_agent: 'yarn/1.22.0' })).toBe('yarn');
    expect(detectPackageManager('/x', { npm_config_user_agent: 'bun/1.0.0' })).toBe('bun');
    expect(detectPackageManager('/x', { npm_config_user_agent: 'npm/10.0.0' })).toBe('npm');
  });
  it('falls back to path markers', () => {
    expect(detectPackageManager('/home/u/Library/pnpm/global/5/node_modules/syntaur', {})).toBe('pnpm');
    expect(detectPackageManager('/home/u/.bun/install/global/node_modules/syntaur', {})).toBe('bun');
    expect(detectPackageManager('/home/u/.config/yarn/global/node_modules/syntaur', {})).toBe('yarn');
    expect(detectPackageManager('/usr/local/lib/node_modules/syntaur/bin', {})).toBe('npm');
  });
  it('uses PNPM_HOME / BUN_INSTALL roots', () => {
    expect(detectPackageManager('/pn/store/syntaur', { PNPM_HOME: '/pn' })).toBe('pnpm');
    expect(detectPackageManager('/bi/bin/syntaur', { BUN_INSTALL: '/bi' })).toBe('bun');
  });
  it('returns null when ambiguous', () => {
    expect(detectPackageManager('/random/place/syntaur', {})).toBeNull();
  });
});

describe('bunGlobalNodeModulesDir', () => {
  it('honors BUN_INSTALL_GLOBAL_DIR', () => {
    expect(bunGlobalNodeModulesDir({ BUN_INSTALL_GLOBAL_DIR: '/cfg/bun-global' })).toBe('/cfg/bun-global/node_modules');
  });
  it('falls back to BUN_INSTALL/install/global', () => {
    expect(bunGlobalNodeModulesDir({ BUN_INSTALL: '/b' })).toBe('/b/install/global/node_modules');
  });
});

describe('defaultResolveFreshBin', () => {
  it('queries `npm root -g` and returns null when the installed entry is missing', async () => {
    const { runner, calls } = recordingRunner([{ stdout: '/no/such/root' }]);
    const res = await defaultResolveFreshBin('npm', runner, {});
    expect(calls[0]).toMatchObject({ cmd: 'npm', args: ['root', '-g'] });
    expect(res).toBeNull();
  });
  it('queries `pnpm root -g`', async () => {
    const { runner, calls } = recordingRunner([{ stdout: '/no/such/root' }]);
    await defaultResolveFreshBin('pnpm', runner, {});
    expect(calls[0]).toMatchObject({ cmd: 'pnpm', args: ['root', '-g'] });
  });
  it('queries `yarn global dir`', async () => {
    const { runner, calls } = recordingRunner([{ stdout: '/no/such/dir' }]);
    await defaultResolveFreshBin('yarn', runner, {});
    expect(calls[0]).toMatchObject({ cmd: 'yarn', args: ['global', 'dir'] });
  });
  it('bun resolves without a query and returns null when missing', async () => {
    const { runner, calls } = recordingRunner();
    const res = await defaultResolveFreshBin('bun', runner, { BUN_INSTALL: '/no/such/bun' });
    expect(calls).toHaveLength(0);
    expect(res).toBeNull();
  });
});

describe('updateCommand — skip / read-only', () => {
  it('skips a local (dev-linked) install without running anything', async () => {
    const { deps, logs, calls } = makeDeps({ kind: 'local' });
    await run({}, deps);
    expect(calls).toHaveLength(0);
    expect(logs.join('\n')).toMatch(/dev\/linked checkout/);
  });

  it('skips an npx install', async () => {
    const { deps, logs, calls } = makeDeps({ kind: 'npx' });
    await run({}, deps);
    expect(calls).toHaveLength(0);
    expect(logs.join('\n')).toMatch(/via npx/);
  });

  it('--check reports current→available even from a local install, applying nothing', async () => {
    const { deps, logs, calls } = makeDeps({ kind: 'local', old: '0.1.0', latest: '9.9.9' });
    await run({ check: true }, deps);
    expect(calls).toHaveLength(0);
    const out = logs.join('\n');
    expect(out).toMatch(/Update available: 0\.1\.0 → 9\.9\.9/);
    expect(out).toMatch(/install kind: local/);
    // It must NOT print the mutating-path skip message for --check.
    expect(out).not.toMatch(/won't touch a linked install/);
  });

  it('--check says up to date when current >= latest', async () => {
    const { deps, logs } = makeDeps({ kind: 'global', old: '9.9.9', latest: '9.9.9' });
    await run({ check: true }, deps);
    expect(logs.join('\n')).toMatch(/up to date \(9\.9\.9\)/);
  });
});

describe('updateCommand — version flow', () => {
  it('is a no-op when already at latest (runner not called)', async () => {
    const { deps, logs, calls } = makeDeps({ kind: 'global', old: '9.9.9', latest: '9.9.9' });
    await run({}, deps);
    expect(calls).toHaveLength(0);
    expect(logs.join('\n')).toMatch(/Already up to date/);
  });

  it('explicit --version OLDER than current bypasses the no-op (downgrade)', async () => {
    const { deps, calls } = makeDeps({ kind: 'global', old: '0.23.0', env: { npm_config_user_agent: 'npm/10' } });
    await run({ version: '0.22.0' }, deps);
    expect(calls[0]).toMatchObject({ cmd: 'npm', args: ['install', '-g', 'syntaur@0.22.0'] });
  });

  it('errors when latest cannot be resolved and no --version', async () => {
    const { deps } = makeDeps({ kind: 'global', latest: null });
    await expect(run({}, deps)).rejects.toThrow(/npm registry/i);
  });

  it('treats an unreadable current version as updateable (not a no-op)', async () => {
    const { deps, calls } = makeDeps({
      kind: 'global',
      latest: '9.9.9',
      env: { npm_config_user_agent: 'npm/10' },
      readOldVersion: async () => null,
    });
    await run({ skipRefresh: true }, deps);
    expect(calls[0]).toMatchObject({ cmd: 'npm', args: ['install', '-g', 'syntaur@9.9.9'] });
  });
});

describe('updateCommand — fresh-bin + target pinning', () => {
  it('runs the resolved fresh bin via process.execPath when resolution succeeds', async () => {
    const fresh = { cmd: process.execPath, baseArgs: ['/g/node_modules/syntaur/bin/syntaur.js'] };
    const { deps, calls } = makeDeps({
      kind: 'global',
      old: '0.1.0',
      latest: '9.9.9',
      env: { npm_config_user_agent: 'npm/10' },
      resolveFreshBin: async () => fresh,
    });
    await run({}, deps);
    expect(calls[1]).toMatchObject({
      cmd: process.execPath,
      args: ['/g/node_modules/syntaur/bin/syntaur.js', 'install-plugin', '--force'],
    });
  });

  it('always pins SYNTAUR_PLUGIN_TARGET even when no managed dir exists', async () => {
    const { deps, calls } = makeDeps({
      kind: 'global',
      old: '0.1.0',
      latest: '9.9.9',
      env: { npm_config_user_agent: 'npm/10' },
      getManagedDir: async () => null,
    });
    await run({}, deps);
    expect(calls[1].env?.SYNTAUR_PLUGIN_TARGET).toMatch(/[\\/]\.claude[\\/]plugins[\\/]syntaur$/);
  });
});

describe('updateCommand — durable-global PMs (classified unknown)', () => {
  it('proceeds (not skipped) for a pnpm global that detects as unknown', async () => {
    const { deps, calls } = makeDeps({
      kind: 'unknown',
      old: '0.1.0',
      latest: '9.9.9',
      env: { npm_config_user_agent: 'pnpm/8.0.0' },
    });
    await run({ skipRefresh: true }, deps);
    expect(calls[0]).toMatchObject({ cmd: 'pnpm', args: ['add', '-g', 'syntaur@9.9.9'] });
  });
});

describe('updateCommand — dry-run', () => {
  it('prints the PM command + refresh, runs nothing', async () => {
    const { deps, logs, calls } = makeDeps({ kind: 'global', old: '0.1.0', latest: '9.9.9', env: { npm_config_user_agent: 'npm/10' } });
    await run({ dryRun: true }, deps);
    expect(calls).toHaveLength(0);
    const out = logs.join('\n');
    expect(out).toMatch(/Would run: npm install -g syntaur@9\.9\.9/);
    expect(out).toMatch(/Would refresh via: syntaur install-plugin --force/);
  });

  it('says "no changes" when already up to date (truthful dry-run)', async () => {
    const { deps, logs, calls } = makeDeps({ kind: 'global', old: '9.9.9', latest: '9.9.9' });
    await run({ dryRun: true }, deps);
    expect(calls).toHaveLength(0);
    expect(logs.join('\n')).toMatch(/Would make no changes/);
  });
});

describe('updateCommand — refresh wiring', () => {
  it('after update, spawns fresh `syntaur install-plugin --force` with SYNTAUR_PLUGIN_TARGET', async () => {
    const { deps, calls } = makeDeps({ kind: 'global', old: '0.1.0', latest: '9.9.9', env: { npm_config_user_agent: 'npm/10' } });
    await run({}, deps);
    expect(calls).toHaveLength(2);
    expect(calls[0].cmd).toBe('npm');
    expect(calls[1]).toMatchObject({ cmd: 'syntaur', args: ['install-plugin', '--force'] });
    expect(calls[1].env?.SYNTAUR_PLUGIN_TARGET).toBe('/home/u/.claude/plugins/syntaur');
  });

  it('forwards --force-skills and --enable to the refresh', async () => {
    const { deps, calls } = makeDeps({ kind: 'global', old: '0.1.0', latest: '9.9.9', env: { npm_config_user_agent: 'npm/10' } });
    await run({ forceSkills: true, enable: true }, deps);
    expect(calls[1].args).toEqual(['install-plugin', '--force', '--force-skills', '--enable']);
  });

  it('--skip-refresh updates the package but does NOT spawn install-plugin', async () => {
    const { deps, calls, logs } = makeDeps({ kind: 'global', old: '0.1.0', latest: '9.9.9', env: { npm_config_user_agent: 'npm/10' } });
    await run({ skipRefresh: true }, deps);
    expect(calls).toHaveLength(1);
    expect(calls[0].cmd).toBe('npm');
    expect(logs.join('\n')).toMatch(/Skipped plugin\/skills refresh/);
  });
});

describe('updateCommand — errors', () => {
  it('rejects an invalid --pm', async () => {
    const { deps } = makeDeps({ kind: 'global' });
    await expect(run({ pm: 'cargo' }, deps)).rejects.toThrow(/Invalid --pm/);
  });

  it('classifies Yarn Berry (no global) failures', async () => {
    const { runner } = recordingRunner([{ code: 1, stderr: 'Unknown command "global"' }]);
    const { deps } = makeDeps({ kind: 'global', old: '0.1.0', latest: '9.9.9', env: { npm_config_user_agent: 'yarn/3.0.0' }, runner });
    await expect(run({}, deps)).rejects.toThrow(/Yarn 2\+ removed it/);
  });

  it('surfaces EACCES permission failures', async () => {
    const { runner } = recordingRunner([{ code: 1, stderr: 'npm ERR! Error: EACCES: permission denied' }]);
    const { deps } = makeDeps({ kind: 'global', old: '0.1.0', latest: '9.9.9', env: { npm_config_user_agent: 'npm/10' }, runner });
    await expect(run({}, deps)).rejects.toThrow(/permissions/i);
  });

  it('reports permissions (not yarn-berry) when a yarn global install hits EACCES on a global path', async () => {
    const { runner } = recordingRunner([{ code: 1, stderr: 'error EACCES: permission denied, mkdir /usr/local/share/.config/yarn/global' }]);
    const { deps } = makeDeps({ kind: 'global', old: '0.1.0', latest: '9.9.9', env: { npm_config_user_agent: 'yarn/1.22.0' }, runner });
    await expect(run({}, deps)).rejects.toThrow(/permissions/i);
  });

  it('treats a refresh failure as a warning, not fatal', async () => {
    const { runner } = recordingRunner([{ code: 0 }, { code: 1, stderr: 'boom' }]);
    const { deps } = makeDeps({ kind: 'global', old: '0.1.0', latest: '9.9.9', env: { npm_config_user_agent: 'npm/10' }, runner });
    const logs: string[] = [];
    deps.log = (m) => logs.push(m);
    await run({}, deps); // resolves (no throw)
    expect(logs.join('\n')).toMatch(/skills refresh failed/);
    expect(logs.join('\n')).toMatch(/Updated syntaur: 0\.1\.0 → 9\.9\.9/);
  });
});
