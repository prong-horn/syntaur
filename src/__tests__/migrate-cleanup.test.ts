import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  mkdtemp,
  mkdir,
  readdir,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
  access,
  rename,
  lstat,
} from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { isSyntaurPluginKey } from '../utils/claude-plugin-key.js';
import { KNOWN_TOP_LEVEL } from '../utils/doctor/checks/structure.js';
import { SYNTAUR_PACK_SKILL_NAMES } from '../utils/doctor/checks/skills.js';
import { runChecks } from '../utils/doctor/index.js';
import {
  RETIRED_HOME_ENTRIES,
  RETIRED_SKILL_NAMES,
  detectLeftovers,
  isActionableLeftover,
  legacyRuntimeDir,
  runMigrateCleanup,
  type CleanupDeps,
} from '../commands/migrate-cleanup.js';
import { V2_MIGRATED_MARKER } from '../commands/migrate-v2.js';

async function treeHash(root: string): Promise<string> {
  const hash = createHash('sha256');
  async function walk(dir: string, prefix: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      hash.update(rel);
      const full = resolve(dir, e.name);
      if (e.isDirectory()) await walk(full, rel);
    }
  }
  await walk(root, '');
  return hash.digest('hex');
}

async function contentTreeFingerprint(root: string): Promise<string> {
  const hash = createHash('sha256');
  async function walk(dir: string, prefix: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      const full = resolve(dir, e.name);
      hash.update(`${rel}\n`);
      if (e.isSymbolicLink()) {
        hash.update(`->${await readlink(full)}\n`);
        continue;
      }
      if (e.isDirectory()) {
        await walk(full, rel);
        continue;
      }
      if (e.isFile()) {
        hash.update(await readFile(full));
        hash.update('\n');
      }
    }
  }
  await walk(root, '');
  return hash.digest('hex');
}

async function writeInstallMarker(
  dir: string,
  opts: { packageName?: string; pluginKind?: string } = {},
): Promise<void> {
  await writeFile(
    resolve(dir, '.syntaur-install.json'),
    JSON.stringify({
      packageName: opts.packageName ?? 'syntaur',
      pluginKind: opts.pluginKind ?? 'claude',
    }) + '\n',
  );
}

async function writeClaudePluginManifest(dir: string, name = 'syntaur'): Promise<void> {
  await mkdir(resolve(dir, '.claude-plugin'), { recursive: true });
  await writeFile(resolve(dir, '.claude-plugin/plugin.json'), JSON.stringify({ name }) + '\n');
}

async function writeOwnedRetiredSkill(skillDir: string, name: string): Promise<void> {
  await mkdir(skillDir, { recursive: true });
  await writeFile(
    resolve(skillDir, 'SKILL.md'),
    `---\nname: ${name}\nmetadata:\n  author: prong-horn\n---\n# ${name}\n`,
  );
}

async function writeCompleteV2Ledger(syntaur: string): Promise<void> {
  await writeFile(
    resolve(syntaur, V2_MIGRATED_MARKER),
    [
      'rename-ids 2026-01-01T00:00:00.000Z',
      'templates 2026-01-01T00:00:00.000Z',
      'statuses 2026-01-01T00:00:00.000Z',
      'derived 2026-01-01T00:00:00.000Z',
      '',
    ].join('\n'),
  );
}

async function minimalValidConfig(syntaur: string): Promise<void> {
  await mkdir(projectsDir(syntaur), { recursive: true });
  await writeFile(
    resolve(syntaur, 'config.md'),
    `---\nversion: "2.0"\ndefaultProjectDir: ${projectsDir(syntaur)}\n---\n`,
  );
}

function makeDeps(
  homeDir: string,
  syntaurHome: string,
  opts?: {
    platform?: NodeJS.Platform;
    runner?: CleanupDeps['runner'];
    tmpDir?: string;
    rename?: CleanupDeps['rename'];
  },
): CleanupDeps {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const runner =
    opts?.runner ??
    ((cmd, args) => {
      calls.push({ cmd, args });
      return { status: 0, stdout: '', stderr: '' };
    });
  return {
    homeDir,
    syntaurHome,
    platform: opts?.platform ?? 'darwin',
    uid: 501,
    env: { ...process.env, HOME: homeDir },
    tmpDir: opts?.tmpDir ?? resolve(homeDir, 'tmp'),
    runner: runner as CleanupDeps['runner'],
    rename: opts?.rename ?? rename,
    now: () => new Date('2026-09-24T17:00:00.000Z'),
  };
}

describe('migrate cleanup', () => {
  const originalHome = process.env.HOME;
  let homeDir: string;
  let syntaurHome: string;

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'syntaur-cleanup-'));
    syntaurHome = resolve(homeDir, '.syntaur');
    process.env.HOME = homeDir;
    process.env.SYNTAUR_HOME = syntaurHome;
    await mkdir(syntaurHome, { recursive: true });
    await mkdir(resolve(homeDir, 'tmp'), { recursive: true });
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    delete process.env.SYNTAUR_HOME;
    await rm(homeDir, { recursive: true, force: true });
  });

  it('constants: retired skills disjoint from current pack', () => {
    for (const name of RETIRED_SKILL_NAMES) {
      expect(SYNTAUR_PACK_SKILL_NAMES as readonly string[]).not.toContain(name);
    }
  });

  it('constants: RETIRED_HOME_ENTRIES disjoint from KNOWN_TOP_LEVEL', () => {
    for (const name of RETIRED_HOME_ENTRIES) {
      expect(KNOWN_TOP_LEVEL.has(name)).toBe(false);
    }
  });

  it('isSyntaurPluginKey matches doctor semantics', () => {
    expect(isSyntaurPluginKey('syntaur')).toBe(true);
    expect(isSyntaurPluginKey('syntaur@user-plugins')).toBe(true);
    expect(isSyntaurPluginKey('syntaur-demos@user-plugins')).toBe(false);
    expect(isSyntaurPluginKey('foo@syntaur')).toBe(false);
  });

  it('legacyRuntimeDir uses sandbox tmp and uid', () => {
    const deps = makeDeps(homeDir, syntaurHome);
    expect(legacyRuntimeDir(deps)).toBe(resolve(homeDir, 'tmp', 'syntaur-501'));
  });

  it('dry run lists claude plugin settings key and changes nothing', async () => {
    await mkdir(resolve(homeDir, '.claude'), { recursive: true });
    await writeFile(
      resolve(homeDir, '.claude/settings.json'),
      JSON.stringify({ enabledPlugins: { 'syntaur@user-plugins': true, 'syntaur-demos@x': true } }, null, 2) + '\n',
    );
    const before = await contentTreeFingerprint(homeDir);
    const { lines } = await runMigrateCleanup({}, makeDeps(homeDir, syntaurHome));
    expect(lines.some((l) => l.includes('syntaur@user-plugins'))).toBe(true);
    expect(lines.some((l) => l.includes('syntaur-demos'))).toBe(false);
    expect(lines.some((l) => l.includes('would move'))).toBe(true);
    expect(await contentTreeFingerprint(homeDir)).toBe(before);
  });

  it('apply removes enabledPlugins key and writes manifest', async () => {
    await mkdir(resolve(homeDir, '.claude'), { recursive: true });
    const settingsPath = resolve(homeDir, '.claude/settings.json');
    await writeFile(
      settingsPath,
      JSON.stringify({ enabledPlugins: { syntaur: true } }, null, 2) + '\n',
    );
    const { lines } = await runMigrateCleanup({ apply: true }, makeDeps(homeDir, syntaurHome));
    expect(lines.some((l) => l.includes('Retired to'))).toBe(true);
    const after = JSON.parse(await readFile(settingsPath, 'utf-8'));
    expect(after.enabledPlugins?.syntaur).toBeUndefined();
    const retiredDirs = (await readdir(homeDir)).filter((n) => n.startsWith('.syntaur-retired-'));
    expect(retiredDirs.length).toBe(1);
    const manifest = JSON.parse(
      await readFile(resolve(homeDir, retiredDirs[0]!, 'manifest.json'), 'utf-8'),
    );
    expect(manifest.entries.length).toBeGreaterThan(0);
  });

  it('second apply is idempotent', async () => {
    await mkdir(resolve(homeDir, '.claude'), { recursive: true });
    await writeFile(
      resolve(homeDir, '.claude/settings.json'),
      JSON.stringify({ enabledPlugins: { syntaur: true } }, null, 2) + '\n',
    );
    await runMigrateCleanup({ apply: true }, makeDeps(homeDir, syntaurHome));
    const retiredCount1 = (await readdir(homeDir)).filter((n) =>
      n.startsWith('.syntaur-retired-'),
    ).length;
    const { lines } = await runMigrateCleanup({ apply: true }, makeDeps(homeDir, syntaurHome));
    expect(lines[0]).toBe('No pre-v2 leftovers found.');
    const retiredCount2 = (await readdir(homeDir)).filter((n) =>
      n.startsWith('.syntaur-retired-'),
    ).length;
    expect(retiredCount2).toBe(retiredCount1);
  });

  it('launchctl bootout runs before plist move on apply', async () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const runner = (cmd: string, args: string[]) => {
      calls.push({ cmd, args });
      return { status: 0, stdout: '', stderr: '' };
    };
    const launchDir = resolve(homeDir, 'Library/LaunchAgents');
    await mkdir(launchDir, { recursive: true });
    const plist = resolve(launchDir, 'com.syntaur.session.scan.plist');
    await writeFile(plist, '<plist/>');
    await runMigrateCleanup({ apply: true }, makeDeps(homeDir, syntaurHome, { runner: runner as CleanupDeps['runner'] }));
    expect(calls.some((c) => c.cmd === 'launchctl' && c.args[0] === 'bootout')).toBe(true);
    expect(await access(plist, constants.F_OK).then(() => false).catch(() => true)).toBe(true);
  });

  it('skips launch agents on non-darwin', async () => {
    const launchDir = resolve(homeDir, 'Library/LaunchAgents');
    await mkdir(launchDir, { recursive: true });
    await writeFile(resolve(launchDir, 'com.syntaur.session.scan.plist'), '<plist/>');
    const leftovers = await detectLeftovers(
      makeDeps(homeDir, syntaurHome, { platform: 'linux' }),
    );
    expect(leftovers.filter((l) => l.category === 'launch-agent')).toHaveLength(0);
  });

  it('refuses user skill named views without syntaur ownership', async () => {
    const skillRoot = resolve(homeDir, '.claude/skills/views');
    await mkdir(skillRoot, { recursive: true });
    await writeFile(
      resolve(skillRoot, 'SKILL.md'),
      `---\nname: views\nmetadata:\n  author: someone\n---\n# Views\n`,
    );
    const leftovers = await detectLeftovers(makeDeps(homeDir, syntaurHome));
    expect(leftovers.filter((l) => l.path === skillRoot)).toHaveLength(0);
  });

  it('detects owned retired skill', async () => {
    const skillRoot = resolve(homeDir, '.agents/skills/grab-ticket');
    await mkdir(skillRoot, { recursive: true });
    await writeFile(
      resolve(skillRoot, 'SKILL.md'),
      `---\nname: grab-ticket\nmetadata:\n  author: prong-horn\n---\n# grab\n`,
    );
    const leftovers = await detectLeftovers(makeDeps(homeDir, syntaurHome));
    expect(leftovers.some((l) => l.path === skillRoot && l.kind === 'move')).toBe(true);
  });

  it('never detects current plan skill as retired', async () => {
    const skillRoot = resolve(homeDir, '.claude/skills/plan');
    await mkdir(skillRoot, { recursive: true });
    await writeFile(
      resolve(skillRoot, 'SKILL.md'),
      `---\nname: plan\nmetadata:\n  author: prong-horn\n---\n# plan\n`,
    );
    const leftovers = await detectLeftovers(makeDeps(homeDir, syntaurHome));
    expect(leftovers.some((l) => l.path === skillRoot)).toBe(false);
  });

  it('blocks non-empty assignments when v2 ledger pending', async () => {
    await mkdir(resolve(syntaurHome, 'assignments', 'x'), { recursive: true });
    await writeFile(resolve(syntaurHome, 'assignments/x/a.md'), 'data');
    await writeFile(resolve(syntaurHome, V2_MIGRATED_MARKER), 'rename-ids 2026-01-01T00:00:00.000Z\n');
    const leftovers = await detectLeftovers(makeDeps(homeDir, syntaurHome));
    const item = leftovers.find((l) => l.path.endsWith('assignments'));
    expect(item?.kind).toBe('blocked');
    expect(item?.detail).toContain('migrate v2');
  });

  it('runtime dir with only sockets is deleted on apply', async () => {
    const runtime = resolve(homeDir, 'tmp', 'syntaur-501');
    await mkdir(runtime, { recursive: true });
    await writeFile(resolve(runtime, 'x.sock'), '');
    await runMigrateCleanup({ apply: true }, makeDeps(homeDir, syntaurHome));
    await expect(access(runtime, constants.F_OK)).rejects.toThrow();
  });

  it('runtime dir with other files is moved on apply', async () => {
    const runtime = resolve(homeDir, 'tmp', 'syntaur-501');
    await mkdir(runtime, { recursive: true });
    await writeFile(resolve(runtime, 'keep.txt'), 'x');
    await runMigrateCleanup({ apply: true }, makeDeps(homeDir, syntaurHome));
    await expect(access(runtime, constants.F_OK)).rejects.toThrow();
    const retired = (await readdir(homeDir)).find((n) => n.startsWith('.syntaur-retired-'));
    expect(retired).toBeDefined();
  });

  it('--root resolves syntaur home entries separately from HOME claude paths', async () => {
    const altRoot = resolve(homeDir, 'alt-syntaur');
    await mkdir(altRoot, { recursive: true });
    await mkdir(resolve(altRoot, 'todos'), { recursive: true });
    await mkdir(resolve(homeDir, '.claude'), { recursive: true });
    await writeFile(
      resolve(homeDir, '.claude/settings.json'),
      JSON.stringify({ enabledPlugins: { syntaur: true } }, null, 2) + '\n',
    );
    const leftovers = await detectLeftovers({
      ...makeDeps(homeDir, altRoot),
      syntaurHome: altRoot,
    });
    expect(leftovers.some((l) => l.path.startsWith(altRoot) && l.detail.includes('todos'))).toBe(
      true,
    );
    expect(leftovers.some((l) => l.path.includes('.claude/settings.json'))).toBe(true);
  });

  it('doctor legacy-leftovers warns with cleanup command', async () => {
    await mkdir(resolve(homeDir, '.claude'), { recursive: true });
    await writeFile(
      resolve(homeDir, '.claude/settings.json'),
      JSON.stringify({ enabledPlugins: { syntaur: true } }, null, 2) + '\n',
    );
    await mkdir(projectsDir(syntaurHome), { recursive: true });
    await writeFile(
      resolve(syntaurHome, 'config.md'),
      `---\nversion: "2.0"\ndefaultProjectDir: ${projectsDir(syntaurHome)}\n---\n`,
    );
    const report = await runChecks();
    const check = report.checks.find((c) => c.id === 'structure.legacy-leftovers');
    expect(check?.status).toBe('warn');
    expect(check?.remediation?.command).toBe('syntaur migrate cleanup --apply');
  });

  it('doctor legacy-leftovers passes on clean sandbox', async () => {
    await mkdir(projectsDir(syntaurHome), { recursive: true });
    await mkdir(resolve(syntaurHome, 'playbooks'), { recursive: true });
    await writeFile(
      resolve(syntaurHome, 'config.md'),
      `---\nversion: "2.0"\ndefaultProjectDir: ${projectsDir(syntaurHome)}\n---\n`,
    );
    const report = await runChecks();
    const check = report.checks.find((c) => c.id === 'structure.legacy-leftovers');
    expect(check?.status).toBe('pass');
  });

  it('unparseable settings.json is blocked and untouched on apply', async () => {
    await mkdir(resolve(homeDir, '.claude'), { recursive: true });
    const settingsPath = resolve(homeDir, '.claude/settings.json');
    await writeFile(settingsPath, '{ bad json');
    await runMigrateCleanup({ apply: true }, makeDeps(homeDir, syntaurHome));
    expect(await readFile(settingsPath, 'utf-8')).toBe('{ bad json');
  });

  it('claude plugin dirs: marker-owned paths moved, unrelated plugins/syntaur untouched', async () => {
    const unowned = resolve(homeDir, '.claude/plugins/syntaur');
    await mkdir(unowned, { recursive: true });
    await writeClaudePluginManifest(unowned, 'not-syntaur');
    let leftovers = await detectLeftovers(makeDeps(homeDir, syntaurHome));
    expect(leftovers.some((l) => l.path === unowned && l.kind === 'move')).toBe(false);
    await rm(unowned, { recursive: true, force: true });

    const direct = resolve(homeDir, '.claude/plugins/syntaur');
    await mkdir(direct, { recursive: true });
    await writeInstallMarker(direct, { pluginKind: 'claude' });

    const mktRoot = resolve(homeDir, 'my-marketplace');
    const mktPlugin = resolve(mktRoot, 'plugins/syntaur');
    await mkdir(mktPlugin, { recursive: true });
    await writeInstallMarker(mktPlugin, { pluginKind: 'claude' });
    await writeFile(
      resolve(homeDir, '.claude/plugins/known_marketplaces.json'),
      JSON.stringify({ user: { installLocation: mktRoot } }) + '\n',
    );

    leftovers = await detectLeftovers(makeDeps(homeDir, syntaurHome));
    const movePaths = leftovers.filter((l) => l.kind === 'move').map((l) => l.path);
    expect(movePaths).toEqual(expect.arrayContaining([direct, mktPlugin]));

    await runMigrateCleanup({ apply: true }, makeDeps(homeDir, syntaurHome));
    expect(await access(direct, constants.F_OK).then(() => false).catch(() => true)).toBe(true);
    expect(await access(mktPlugin, constants.F_OK).then(() => false).catch(() => true)).toBe(true);
  });

  it('claude plugin symlink to unowned target is untouched on apply', async () => {
    const foreign = resolve(homeDir, 'foreign-plugin');
    await mkdir(foreign, { recursive: true });
    await writeClaudePluginManifest(foreign, 'other-product');
    const link = resolve(homeDir, '.claude/plugins/syntaur');
    await mkdir(resolve(homeDir, '.claude/plugins'), { recursive: true });
    await symlink(foreign, link);

    await runMigrateCleanup({ apply: true }, makeDeps(homeDir, syntaurHome));
    expect(await access(link, constants.F_OK).then(() => true).catch(() => false)).toBe(true);
    expect(await access(foreign, constants.F_OK).then(() => true).catch(() => false)).toBe(true);
    expect(await readlink(link)).toBe(foreign);
  });

  it('codex plugin symlink to unowned target is untouched on apply', async () => {
    const foreign = resolve(homeDir, 'foreign-codex-plugin');
    await mkdir(foreign, { recursive: true });
    await mkdir(resolve(foreign, '.codex-plugin'), { recursive: true });
    await writeFile(
      resolve(foreign, '.codex-plugin/plugin.json'),
      JSON.stringify({ name: 'other-product' }) + '\n',
    );
    const link = resolve(homeDir, 'plugins/syntaur');
    await mkdir(resolve(homeDir, 'plugins'), { recursive: true });
    await symlink(foreign, link);

    await runMigrateCleanup({ apply: true }, makeDeps(homeDir, syntaurHome));
    expect(await access(link, constants.F_OK).then(() => true).catch(() => false)).toBe(true);
    expect(await readlink(link)).toBe(foreign);
  });

  it('claude plugin symlink: moves owned link only; target stays', async () => {
    const target = resolve(homeDir, 'real-syntaur-plugin');
    await mkdir(target, { recursive: true });
    await writeClaudePluginManifest(target, 'syntaur');
    const link = resolve(homeDir, '.claude/plugins/syntaur');
    await mkdir(resolve(homeDir, '.claude/plugins'), { recursive: true });
    await symlink(target, link);

    await runMigrateCleanup({ apply: true }, makeDeps(homeDir, syntaurHome));
    expect(await access(link, constants.F_OK).then(() => false).catch(() => true)).toBe(true);
    expect(await access(target, constants.F_OK).then(() => true).catch(() => false)).toBe(true);
  });

  it('dangling ~/.claude/plugins/syntaur symlink is detected and moved', async () => {
    const link = resolve(homeDir, '.claude/plugins/syntaur');
    await mkdir(resolve(homeDir, '.claude/plugins'), { recursive: true });
    await symlink(resolve(homeDir, 'missing-target'), link);
    const missingTarget = resolve(homeDir, 'missing-target');

    const leftovers = await detectLeftovers(makeDeps(homeDir, syntaurHome));
    expect(leftovers.some((l) => l.path === link && l.kind === 'move')).toBe(true);

    await runMigrateCleanup({ apply: true }, makeDeps(homeDir, syntaurHome));
    expect(await access(link, constants.F_OK).then(() => false).catch(() => true)).toBe(true);
    expect(await access(missingTarget, constants.F_OK).then(() => false).catch(() => true)).toBe(
      true,
    );
  });

  it('dangling agent plugin symlinks under plugins/ are detected and moved', async () => {
    for (const rel of ['plugins/syntaur', '.codex/plugins/syntaur'] as const) {
      const link = resolve(homeDir, rel);
      await mkdir(dirname(link), { recursive: true });
      await symlink(resolve(homeDir, `missing-${rel.replace(/\//g, '-')}`), link);

      const leftovers = await detectLeftovers(makeDeps(homeDir, syntaurHome));
      expect(leftovers.some((l) => l.path === link && l.kind === 'move')).toBe(true);

      await runMigrateCleanup({ apply: true }, makeDeps(homeDir, syntaurHome));
      expect(await access(link, constants.F_OK).then(() => false).catch(() => true)).toBe(true);
      await rm(dirname(link), { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('dangling ~/.pi/agent/extensions/syntaur symlink is untouched', async () => {
    const link = resolve(homeDir, '.pi/agent/extensions/syntaur');
    await mkdir(dirname(link), { recursive: true });
    await symlink(resolve(homeDir, 'missing-pi-ext'), link);

    const leftovers = await detectLeftovers(makeDeps(homeDir, syntaurHome));
    expect(leftovers.some((l) => l.path === link)).toBe(false);

    await runMigrateCleanup({ apply: true }, makeDeps(homeDir, syntaurHome));
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
  });

  it('dangling retired skill symlinks: replan moved; plan and custom names untouched', async () => {
    const skillsDir = resolve(homeDir, '.claude/skills');
    await mkdir(skillsDir, { recursive: true });

    const replanLink = resolve(skillsDir, 'replan');
    await symlink(resolve(homeDir, 'missing-replan-target'), replanLink);

    const planLink = resolve(skillsDir, 'plan');
    await symlink(resolve(homeDir, 'missing-plan-target'), planLink);

    const customLink = resolve(skillsDir, 'my-own');
    await symlink(resolve(homeDir, 'missing-custom-target'), customLink);

    const leftovers = await detectLeftovers(makeDeps(homeDir, syntaurHome));
    expect(leftovers.some((l) => l.path === replanLink && l.kind === 'move')).toBe(true);
    expect(leftovers.some((l) => l.path === planLink)).toBe(false);
    expect(leftovers.some((l) => l.path === customLink)).toBe(false);

    await runMigrateCleanup({ apply: true }, makeDeps(homeDir, syntaurHome));
    await expect(lstat(replanLink)).rejects.toThrow();
    expect((await lstat(planLink)).isSymbolicLink()).toBe(true);
    expect((await lstat(customLink)).isSymbolicLink()).toBe(true);
  });

  it('symlink loops are never owned (claude plugin and retired skill)', async () => {
    const loopDir = resolve(homeDir, 'loop-pair');
    await mkdir(loopDir, { recursive: true });
    const loopA = resolve(loopDir, 'a');
    const loopB = resolve(loopDir, 'b');
    await symlink(loopB, loopA);
    await symlink(loopA, loopB);

    const pluginLink = resolve(homeDir, '.claude/plugins/syntaur');
    await mkdir(resolve(homeDir, '.claude/plugins'), { recursive: true });
    await rm(pluginLink, { force: true }).catch(() => undefined);
    await symlink(loopA, pluginLink);

    const skillLink = resolve(homeDir, '.claude/skills/replan');
    await mkdir(resolve(homeDir, '.claude/skills'), { recursive: true });
    await symlink(loopB, skillLink);

    const leftovers = await detectLeftovers(makeDeps(homeDir, syntaurHome));
    expect(leftovers.some((l) => l.path === pluginLink)).toBe(false);
    expect(leftovers.some((l) => l.path === skillLink)).toBe(false);

    await runMigrateCleanup({ apply: true }, makeDeps(homeDir, syntaurHome));
    expect((await lstat(pluginLink)).isSymbolicLink()).toBe(true);
    expect((await lstat(skillLink)).isSymbolicLink()).toBe(true);
  });

  it('unowned agent plugin dirs named syntaur are untouched', async () => {
    for (const rel of ['plugins/syntaur', '.codex/plugins/syntaur'] as const) {
      const dir = resolve(homeDir, rel);
      await mkdir(dir, { recursive: true });
      await writeFile(resolve(dir, 'plugin.json'), JSON.stringify({ name: 'other-product' }) + '\n');
      const leftovers = await detectLeftovers(makeDeps(homeDir, syntaurHome));
      expect(leftovers.some((l) => l.path === dir && l.kind === 'move')).toBe(false);
      await runMigrateCleanup({ apply: true }, makeDeps(homeDir, syntaurHome));
      expect(await access(dir, constants.F_OK).then(() => true).catch(() => false)).toBe(true);
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('known_marketplaces-only claude plugin moved without config integrations block', async () => {
    await minimalValidConfig(syntaurHome);
    const mktRoot = resolve(homeDir, 'external-marketplace');
    const mktPlugin = resolve(mktRoot, 'plugins/syntaur');
    await mkdir(mktPlugin, { recursive: true });
    await writeInstallMarker(mktPlugin, { pluginKind: 'claude' });
    await mkdir(resolve(homeDir, '.claude/plugins'), { recursive: true });
    await writeFile(
      resolve(homeDir, '.claude/plugins/known_marketplaces.json'),
      JSON.stringify({ ext: { installLocation: mktRoot } }) + '\n',
    );

    const leftovers = await detectLeftovers(makeDeps(homeDir, syntaurHome));
    expect(leftovers.some((l) => l.path === mktPlugin && l.kind === 'move')).toBe(true);
    await runMigrateCleanup({ apply: true }, makeDeps(homeDir, syntaurHome));
    expect(await access(mktPlugin, constants.F_OK).then(() => false).catch(() => true)).toBe(true);
  });

  it('retired skill symlink into retiring plugin dir is detected via retiringPaths', async () => {
    const plugin = resolve(homeDir, 'plugins/syntaur');
    await mkdir(plugin, { recursive: true });
    await writeInstallMarker(plugin, { pluginKind: 'codex' });
    const skillInside = resolve(plugin, 'skills/grab-ticket');
    await mkdir(skillInside, { recursive: true });
    await writeFile(
      resolve(skillInside, 'SKILL.md'),
      `---\nname: grab-ticket\nmetadata:\n  author: someone-else\n---\n# grab\n`,
    );
    const link = resolve(homeDir, '.claude/skills/grab-ticket');
    await mkdir(resolve(homeDir, '.claude/skills'), { recursive: true });
    await symlink(skillInside, link);

    const leftovers = await detectLeftovers(makeDeps(homeDir, syntaurHome));
    expect(leftovers.some((l) => l.path === link && l.kind === 'move')).toBe(true);
  });

  it('EXDEV copyTree preserves symlinks, skips sockets, removes source after copy', async () => {
    const pluginDir = resolve(homeDir, '.claude/plugins/syntaur');
    await mkdir(pluginDir, { recursive: true });
    await writeInstallMarker(pluginDir, { pluginKind: 'claude' });

    const fileTarget = resolve(homeDir, 'symlink-file-target.txt');
    await writeFile(fileTarget, 'payload');
    await symlink(fileTarget, resolve(pluginDir, 'linked-file.txt'));
    const dirTarget = resolve(homeDir, 'symlink-dir-target');
    await mkdir(dirTarget);
    await symlink(dirTarget, resolve(pluginDir, 'linked-dir'));

    const sockPath = resolve(pluginDir, 'daemon.sock');
    const server = createServer();
    await new Promise<void>((resolvePromise, reject) => {
      server.listen(sockPath, () => resolvePromise()); // listen-guard: ignore
      server.on('error', reject);
    });

    let renameAttempts = 0;
    const exdevRename: CleanupDeps['rename'] = async (src, dest) => {
      renameAttempts += 1;
      if (renameAttempts === 1) {
        const err = new Error('EXDEV') as NodeJS.ErrnoException;
        err.code = 'EXDEV';
        throw err;
      }
      await rename(src, dest);
    };

    await runMigrateCleanup(
      { apply: true },
      makeDeps(homeDir, syntaurHome, { rename: exdevRename }),
    );
    server.close();

    expect(await access(pluginDir, constants.F_OK).then(() => false).catch(() => true)).toBe(true);
    const retired = (await readdir(homeDir)).find((n) => n.startsWith('.syntaur-retired-'))!;
    const retiredPlugin = resolve(homeDir, retired, '.claude/plugins/syntaur');
    expect(await readlink(resolve(retiredPlugin, 'linked-file.txt'))).toBe(fileTarget);
    expect(await readlink(resolve(retiredPlugin, 'linked-dir'))).toBe(dirTarget);
    expect(
      await access(resolve(retiredPlugin, 'daemon.sock'), constants.F_OK)
        .then(() => true)
        .catch(() => false),
    ).toBe(false);
  });

  it('EXDEV move of top-level plugin symlink preserves symlink at retired path', async () => {
    const realPlugin = resolve(homeDir, 'real-owned-plugin');
    await mkdir(realPlugin, { recursive: true });
    await writeInstallMarker(realPlugin, { pluginKind: 'claude' });
    const link = resolve(homeDir, '.claude/plugins/syntaur');
    await mkdir(resolve(homeDir, '.claude/plugins'), { recursive: true });
    await symlink(realPlugin, link);

    let renameAttempts = 0;
    const exdevRename: CleanupDeps['rename'] = async (src, dest) => {
      renameAttempts += 1;
      if (renameAttempts === 1) {
        const err = new Error('EXDEV') as NodeJS.ErrnoException;
        err.code = 'EXDEV';
        throw err;
      }
      await rename(src, dest);
    };

    await runMigrateCleanup(
      { apply: true },
      makeDeps(homeDir, syntaurHome, { rename: exdevRename }),
    );

    expect(await access(link, constants.F_OK).then(() => false).catch(() => true)).toBe(true);
    expect(await access(realPlugin, constants.F_OK).then(() => true).catch(() => false)).toBe(true);
    const retired = (await readdir(homeDir)).find((n) => n.startsWith('.syntaur-retired-'))!;
    const retiredLink = resolve(homeDir, retired, '.claude/plugins/syntaur');
    expect((await lstat(retiredLink)).isSymbolicLink()).toBe(true);
    expect(await readlink(retiredLink)).toBe(realPlugin);
  });

  it('claude marketplace.json and enabledPlugins edit syntaur only with backup', async () => {
    const mktRoot = resolve(homeDir, 'mkt-root');
    await mkdir(resolve(mktRoot, '.claude-plugin'), { recursive: true });
    const marketplacePath = resolve(mktRoot, '.claude-plugin/marketplace.json');
    await writeFile(
      marketplacePath,
      JSON.stringify({
        plugins: [{ name: 'syntaur' }, { name: 'syntaur-demos' }, { name: 'keep' }],
      },
      null,
      2,
    ) + '\n',
    );
    await mkdir(resolve(homeDir, '.claude/plugins'), { recursive: true });
    await writeFile(
      resolve(homeDir, '.claude/plugins/known_marketplaces.json'),
      JSON.stringify({ m: { installLocation: mktRoot } }) + '\n',
    );
    await mkdir(resolve(homeDir, '.claude'), { recursive: true });
    await writeFile(
      resolve(homeDir, '.claude/settings.json'),
      JSON.stringify({
        enabledPlugins: {
          'syntaur@user-plugins': true,
          syntaur: true,
          'syntaur-demos@user-plugins': true,
          'other@x': true,
        },
      },
      null,
      2,
    ) + '\n',
    );

    await runMigrateCleanup({ apply: true }, makeDeps(homeDir, syntaurHome));
    const mkt = JSON.parse(await readFile(marketplacePath, 'utf-8'));
    expect(mkt.plugins.map((p: { name: string }) => p.name)).toEqual(['syntaur-demos', 'keep']);
    const settings = JSON.parse(await readFile(resolve(homeDir, '.claude/settings.json'), 'utf-8'));
    expect(settings.enabledPlugins).toEqual({ 'syntaur-demos@user-plugins': true, 'other@x': true });

    const retired = (await readdir(homeDir)).find((n) => n.startsWith('.syntaur-retired-'))!;
    const backup = resolve(
      homeDir,
      retired,
      '_edited',
      retiredRelativeForTest(homeDir, marketplacePath),
    );
    expect(await readFile(backup, 'utf-8')).toContain('syntaur-demos');
  });

  it('installed_plugins.json flat and versioned shapes; cache dir moved', async () => {
    const pluginsDir = resolve(homeDir, '.claude/plugins');
    await mkdir(pluginsDir, { recursive: true });

    const flatPath = resolve(pluginsDir, 'installed_plugins.json');
    await writeFile(
      flatPath,
      JSON.stringify({
        'syntaur@mkt-a': { v: 1 },
        'other@x': { v: 2 },
      },
      null,
      2,
    ) + '\n',
    );
    const cacheA = resolve(pluginsDir, 'cache/mkt-a/syntaur');
    await mkdir(cacheA, { recursive: true });
    await writeFile(resolve(cacheA, 'x'), 'cache');

    await runMigrateCleanup({ apply: true }, makeDeps(homeDir, syntaurHome));
    const flatAfter = JSON.parse(await readFile(flatPath, 'utf-8'));
    expect(flatAfter['syntaur@mkt-a']).toBeUndefined();
    expect(flatAfter['other@x']).toBeDefined();
    expect(await access(cacheA, constants.F_OK).then(() => false).catch(() => true)).toBe(true);

    await writeFile(
      flatPath,
      JSON.stringify(
        { version: 1, plugins: { 'syntaur@mkt-b': {}, 'keep@y': {} } },
        null,
        2,
      ) + '\n',
    );
    const cacheB = resolve(pluginsDir, 'cache/mkt-b/syntaur');
    await mkdir(cacheB, { recursive: true });

    await runMigrateCleanup({ apply: true }, makeDeps(homeDir, syntaurHome));
    const versioned = JSON.parse(await readFile(flatPath, 'utf-8'));
    expect(versioned.plugins['syntaur@mkt-b']).toBeUndefined();
    expect(versioned.plugins['keep@y']).toBeDefined();
    expect(await access(cacheB, constants.F_OK).then(() => false).catch(() => true)).toBe(true);
  });

  it('codex plugin dir, agents marketplace edit, and default shell file move', async () => {
    const codexDir = resolve(homeDir, 'plugins/syntaur');
    await mkdir(codexDir, { recursive: true });
    await writeInstallMarker(codexDir, { pluginKind: 'codex' });

    const agentsMkt = resolve(homeDir, '.agents/plugins/marketplace.json');
    await mkdir(dirname(agentsMkt), { recursive: true });
    await writeFile(
      agentsMkt,
      JSON.stringify({
        name: 'local',
        interface: { displayName: 'Local Plugins' },
        plugins: [{ name: 'syntaur' }, { name: 'other-agent' }],
      },
      null,
      2,
    ) + '\n',
    );

    await runMigrateCleanup({ apply: true }, makeDeps(homeDir, syntaurHome));
    expect(await access(codexDir, constants.F_OK).then(() => false).catch(() => true)).toBe(true);
    const edited = JSON.parse(await readFile(agentsMkt, 'utf-8'));
    expect(edited.plugins.map((p: { name: string }) => p.name)).toEqual(['other-agent']);

    await writeFile(
      agentsMkt,
      JSON.stringify({
        name: 'local',
        interface: { displayName: 'Local Plugins' },
        plugins: [{ name: 'syntaur' }],
      },
      null,
      2,
    ) + '\n',
    );
    await runMigrateCleanup({ apply: true }, makeDeps(homeDir, syntaurHome));
    expect(await access(agentsMkt, constants.F_OK).then(() => false).catch(() => true)).toBe(true);
  });

  it('pi markerless extension, hermes HERMES_HOME, and non-syntaur pi dir untouched', async () => {
    const piBare = resolve(homeDir, '.pi/agent/extensions/syntaur');
    await mkdir(piBare, { recursive: true });
    await writeFile(resolve(piBare, 'note.md'), 'neutral content\n');
    expect(
      (await detectLeftovers(makeDeps(homeDir, syntaurHome))).some((l) => l.path === piBare),
    ).toBe(false);
    await rm(piBare, { recursive: true, force: true });

    const piOwned = resolve(homeDir, '.pi/agent/extensions/syntaur');
    await mkdir(piOwned, { recursive: true });
    await writeFile(resolve(piOwned, 'ext.json'), '{"product":"syntaur"}\n');

    const hermesRoot = resolve(homeDir, 'hermes-home');
    const hermesPlugin = resolve(hermesRoot, 'plugins/syntaur');
    await mkdir(hermesPlugin, { recursive: true });
    await writeInstallMarker(hermesPlugin, { pluginKind: 'codex' });

    const deps = makeDeps(homeDir, syntaurHome);
    deps.env = { ...deps.env, HERMES_HOME: hermesRoot };

    const leftovers = await detectLeftovers(deps);
    expect(leftovers.some((l) => l.path === piOwned && l.kind === 'move')).toBe(true);
    expect(leftovers.some((l) => l.path === hermesPlugin && l.kind === 'move')).toBe(true);

    await runMigrateCleanup({ apply: true }, deps);
    expect(await access(piOwned, constants.F_OK).then(() => false).catch(() => true)).toBe(true);
    expect(await access(hermesPlugin, constants.F_OK).then(() => false).catch(() => true)).toBe(
      true,
    );
  });

  it('replan skill symlink and skill-lock entry; link retired before target', async () => {
    const target = resolve(homeDir, '.agents/skills/replan');
    await writeOwnedRetiredSkill(target, 'replan');
    const link = resolve(homeDir, '.claude/skills/replan');
    await mkdir(resolve(homeDir, '.claude/skills'), { recursive: true });
    await symlink(target, link);

    const lockPath = resolve(homeDir, '.agents/.skill-lock.json');
    await mkdir(resolve(homeDir, '.agents'), { recursive: true });
    await writeFile(
      lockPath,
      JSON.stringify({
        replan: { source: 'prong-horn/syntaur' },
        plan: { source: 'prong-horn/syntaur' },
      },
      null,
      2,
    ) + '\n',
    );

    const dry = await runMigrateCleanup({}, makeDeps(homeDir, syntaurHome));
    const dryPaths = dry.lines.filter((l) => l.includes('[dry-run]') && l.includes('/replan'));
    expect(dryPaths.some((l) => l.includes('.claude/skills/replan'))).toBe(true);
    expect(dryPaths.some((l) => l.includes('.agents/skills/replan'))).toBe(true);

    await runMigrateCleanup({ apply: true }, makeDeps(homeDir, syntaurHome));
    const retired = (await readdir(homeDir)).find((n) => n.startsWith('.syntaur-retired-'))!;
    const manifest = JSON.parse(
      await readFile(resolve(homeDir, retired, 'manifest.json'), 'utf-8'),
    );
    const replanEntries = manifest.entries
      .map((e: { original: string }) => e.original)
      .filter((p: string) => p.includes('replan'));
    expect(replanEntries.findIndex((p: string) => p.includes('.claude/skills'))).toBeLessThan(
      replanEntries.findIndex((p: string) => p.includes('.agents/skills')),
    );
    expect(await access(link, constants.F_OK).then(() => false).catch(() => true)).toBe(true);
    expect(await access(target, constants.F_OK).then(() => false).catch(() => true)).toBe(true);
    const lock = JSON.parse(await readFile(lockPath, 'utf-8'));
    expect(lock.replan).toBeUndefined();
    expect(lock.plan).toBeDefined();
  });

  it('url handler: lsregister before move; sibling kept; foreign bundle skipped; linux skipped', async () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const runner = (cmd: string, args: string[]) => {
      calls.push({ cmd, args });
      const status = cmd.includes('lsregister') ? 17 : 0;
      return { status, stdout: '', stderr: '' };
    };
    const supportDir = resolve(homeDir, 'Library/Application Support/Syntaur');
    const ownedApp = resolve(supportDir, 'syntaur-url.app');
    await mkdir(resolve(ownedApp, 'Contents'), { recursive: true });
    await writeFile(
      resolve(ownedApp, 'Contents/Info.plist'),
      '<plist>app.syntaur.url-handler</plist>',
    );
    await writeFile(resolve(supportDir, 'sibling.txt'), 'stay');

    const foreignApp = resolve(homeDir, 'Applications/other-url.app');
    await mkdir(resolve(foreignApp, 'Contents'), { recursive: true });
    await writeFile(resolve(foreignApp, 'Contents/Info.plist'), '<plist>app.other.handler</plist>');

    await runMigrateCleanup(
      { apply: true },
      makeDeps(homeDir, syntaurHome, { runner: runner as CleanupDeps['runner'] }),
    );
    const lsIdx = calls.findIndex((c) => c.args[0] === '-u' && c.args[1] === ownedApp);
    expect(lsIdx).toBeGreaterThanOrEqual(0);
    expect(calls[lsIdx]!.cmd).toContain('lsregister');
    expect(await access(ownedApp, constants.F_OK).then(() => false).catch(() => true)).toBe(true);
    expect(await readFile(resolve(supportDir, 'sibling.txt'), 'utf-8')).toBe('stay');
    expect(await access(foreignApp, constants.F_OK).then(() => true).catch(() => false)).toBe(true);
    const retired = (await readdir(homeDir)).find((n) => n.startsWith('.syntaur-retired-'))!;
    const manifest = JSON.parse(
      await readFile(resolve(homeDir, retired, 'manifest.json'), 'utf-8'),
    );
    const urlEntry = manifest.entries.find((e: { category: string }) => e.category === 'url-handler');
    expect(urlEntry?.command?.status).toBe(17);

    const linuxLeftovers = await detectLeftovers(
      makeDeps(homeDir, syntaurHome, { platform: 'linux' }),
    );
    expect(linuxLeftovers.filter((l) => l.category === 'url-handler')).toHaveLength(0);
  });

  it('home-commit LaunchAgent plist is not retired and gets no bootout', async () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const runner = (cmd: string, args: string[]) => {
      calls.push({ cmd, args });
      return { status: 0, stdout: '', stderr: '' };
    };
    const launchDir = resolve(homeDir, 'Library/LaunchAgents');
    await mkdir(launchDir, { recursive: true });
    const homeCommit = resolve(launchDir, 'com.syntaur.home-commit.plist');
    await writeFile(homeCommit, '<plist/>');

    await runMigrateCleanup(
      { apply: true },
      makeDeps(homeDir, syntaurHome, { runner: runner as CleanupDeps['runner'] }),
    );
    expect(await readFile(homeCommit, 'utf-8')).toBe('<plist/>');
    expect(calls.some((c) => c.args.some((a) => a.includes('home-commit')))).toBe(false);
  });

  it('retired home entries move with manifest mirrors', async () => {
    await writeCompleteV2Ledger(syntaurHome);
    const entries = [
      'logs',
      'todos',
      'servers',
      'saved-views.json',
      'syntaur.db.pre-purge-x.bak',
      'daemon',
    ];
    for (const name of entries) {
      const p = resolve(syntaurHome, name);
      if (name.endsWith('.bak') || name.endsWith('.json')) {
        await writeFile(p, '{}');
      } else {
        await mkdir(p, { recursive: true });
        await writeFile(resolve(p, 'x'), '1');
      }
    }
    await mkdir(resolve(syntaurHome, 'runtime/daemon'), { recursive: true });
    await writeFile(resolve(syntaurHome, 'runtime/daemon/x'), 'd');
    await mkdir(resolve(syntaurHome, 'runtime/other'), { recursive: true });
    await writeFile(resolve(syntaurHome, 'runtime/other/keep'), 'k');
    await mkdir(resolve(syntaurHome, 'projects/p/todos'), { recursive: true });
    await writeFile(resolve(syntaurHome, 'projects/p/todos/t.txt'), 't');

    await runMigrateCleanup({ apply: true }, makeDeps(homeDir, syntaurHome));
    for (const name of entries) {
      expect(await access(resolve(syntaurHome, name), constants.F_OK).then(() => false).catch(() => true)).toBe(
        true,
      );
    }
    expect(await access(resolve(syntaurHome, 'runtime/daemon'), constants.F_OK).then(() => false).catch(() => true)).toBe(
      true,
    );
    expect(await access(resolve(syntaurHome, 'runtime/other/keep'), constants.F_OK).then(() => true).catch(() => false)).toBe(
      true,
    );
    expect(await access(resolve(syntaurHome, 'projects/p/todos'), constants.F_OK).then(() => false).catch(() => true)).toBe(
      true,
    );

    const retired = (await readdir(homeDir)).find((n) => n.startsWith('.syntaur-retired-'))!;
    const manifest = JSON.parse(
      await readFile(resolve(homeDir, retired, 'manifest.json'), 'utf-8'),
    );
    const originals = manifest.entries.map((e: { original: string }) => e.original);
    expect(originals).toContain(resolve(syntaurHome, 'logs'));
    expect(originals).toContain(resolve(syntaurHome, 'runtime/daemon'));
    expect(originals).toContain(resolve(syntaurHome, 'projects/p/todos'));
  });

  it('data-bearing guard blocks missions/tickets/assignments but still processes other leftovers', async () => {
    await writeCompleteV2Ledger(syntaurHome);
    await mkdir(resolve(syntaurHome, 'missions/x'), { recursive: true });
    await writeFile(resolve(syntaurHome, 'missions/x/m.md'), 'm');
    await mkdir(resolve(syntaurHome, 'tickets/x'), { recursive: true });
    await writeFile(resolve(syntaurHome, 'tickets/x/t.md'), 't');
    await mkdir(resolve(syntaurHome, 'projects/p/assignments'), { recursive: true });
    await writeFile(resolve(syntaurHome, 'projects/p/assignments/a.md'), 'a');
    await mkdir(resolve(syntaurHome, 'projects/q/assignments'), { recursive: true });
    await mkdir(resolve(syntaurHome, 'logs'), { recursive: true });
    await writeFile(resolve(syntaurHome, 'logs/l.log'), 'l');
    await mkdir(resolve(homeDir, '.claude'), { recursive: true });
    await writeFile(
      resolve(homeDir, '.claude/settings.json'),
      JSON.stringify({ enabledPlugins: { syntaur: true } }, null, 2) + '\n',
    );

    const leftovers = await detectLeftovers(makeDeps(homeDir, syntaurHome));
    expect(leftovers.find((l) => l.path === resolve(syntaurHome, 'missions'))?.kind).toBe('blocked');
    expect(leftovers.find((l) => l.path === resolve(syntaurHome, 'tickets'))?.kind).toBe('blocked');
    expect(
      leftovers.find((l) => l.path === resolve(syntaurHome, 'projects/p/assignments'))?.kind,
    ).toBe('blocked');

    await runMigrateCleanup({ apply: true }, makeDeps(homeDir, syntaurHome));
    expect(await access(resolve(syntaurHome, 'missions'), constants.F_OK).then(() => true).catch(() => false)).toBe(
      true,
    );
    expect(await access(resolve(syntaurHome, 'logs'), constants.F_OK).then(() => false).catch(() => true)).toBe(
      true,
    );
    const settings = JSON.parse(await readFile(resolve(homeDir, '.claude/settings.json'), 'utf-8'));
    expect(settings.enabledPlugins?.syntaur).toBeUndefined();

    await rm(resolve(syntaurHome, 'projects/p/assignments'), { recursive: true, force: true });
    await mkdir(resolve(syntaurHome, 'projects/p/assignments'), { recursive: true });
    await mkdir(resolve(syntaurHome, 'projects/p/tickets'), { recursive: true });
    await writeFile(resolve(syntaurHome, 'projects/p/tickets/t.md'), 't');

    await runMigrateCleanup({ apply: true }, makeDeps(homeDir, syntaurHome));
    expect(
      await access(resolve(syntaurHome, 'projects/p/assignments'), constants.F_OK).then(() => false).catch(() => true),
    ).toBe(true);
  });

  it('config.md retired keys removed with backup; other lines byte-identical', async () => {
    await mkdir(projectsDir(syntaurHome), { recursive: true });
    const configPath = resolve(syntaurHome, 'config.md');
    const body = '\n\n# Notes\nKeep this body.\n';
    const original =
      `---\nversion: "2.0"\ndefaultProjectDir: ${projectsDir(syntaurHome)}\nbackup:\n  enabled: true\nagents: []\nworkflows: {}\nagentDiscovery: x\nhotkeys: {}\n---` +
      body;
    await writeFile(configPath, original);

    await runMigrateCleanup({ apply: true }, makeDeps(homeDir, syntaurHome));
    const after = await readFile(configPath, 'utf-8');
    expect(after).toContain('version: "2.0"');
    expect(after).toContain('defaultProjectDir:');
    expect(after).toContain('hotkeys: {}');
    expect(after).not.toMatch(/^agents:/m);
    expect(after).not.toMatch(/^workflows:/m);
    expect(after).not.toMatch(/^agentDiscovery:/m);
    expect(after).not.toMatch(/^backup:/m);
    expect(after.endsWith(body)).toBe(true);

    const retired = (await readdir(homeDir)).find((n) => n.startsWith('.syntaur-retired-'))!;
    const backup = resolve(
      homeDir,
      retired,
      '_edited',
      retiredRelativeForTest(homeDir, configPath),
    );
    expect(await readFile(backup, 'utf-8')).toBe(original);
  });

  it('idempotence: blocked plus movable — second dry run only blocked; second apply no new retired dir', async () => {
    await writeCompleteV2Ledger(syntaurHome);
    await mkdir(resolve(syntaurHome, 'missions/x'), { recursive: true });
    await writeFile(resolve(syntaurHome, 'missions/x/m.md'), 'm');
    await mkdir(resolve(syntaurHome, 'todos'), { recursive: true });
    await writeFile(resolve(syntaurHome, 'todos/t.txt'), 't');

    await runMigrateCleanup({ apply: true }, makeDeps(homeDir, syntaurHome));
    const retired1 = (await readdir(homeDir)).filter((n) => n.startsWith('.syntaur-retired-'));

    const dry2 = await runMigrateCleanup({}, makeDeps(homeDir, syntaurHome));
    expect(dry2.lines.some((l) => l.includes('missions') && l.includes('blocked'))).toBe(true);
    expect(dry2.lines.some((l) => l.includes('todos'))).toBe(false);

    await runMigrateCleanup({ apply: true }, makeDeps(homeDir, syntaurHome));
    const retired2 = (await readdir(homeDir)).filter((n) => n.startsWith('.syntaur-retired-'));
    expect(retired2).toEqual(retired1);
  });

  it('dry run leaves full content tree unchanged', async () => {
    await writeCompleteV2Ledger(syntaurHome);
    await mkdir(resolve(syntaurHome, 'logs'), { recursive: true });
    await writeFile(resolve(syntaurHome, 'logs/x'), 'l');
    await mkdir(resolve(homeDir, '.claude/plugins/syntaur'), { recursive: true });
    await writeInstallMarker(resolve(homeDir, '.claude/plugins/syntaur'));
    await mkdir(resolve(homeDir, '.claude'), { recursive: true });
    await writeFile(
      resolve(homeDir, '.claude/settings.json'),
      JSON.stringify({ enabledPlugins: { syntaur: true } }, null, 2) + '\n',
    );
    const launchDir = resolve(homeDir, 'Library/LaunchAgents');
    await mkdir(launchDir, { recursive: true });
    await writeFile(resolve(launchDir, 'com.syntaur.session.scan.plist'), '<p/>');
    const runtime = resolve(homeDir, 'tmp/syntaur-501');
    await mkdir(runtime, { recursive: true });
    await writeFile(resolve(runtime, 'a.sock'), '');

    const before = await contentTreeFingerprint(homeDir);
    await runMigrateCleanup({}, makeDeps(homeDir, syntaurHome));
    const after = await contentTreeFingerprint(homeDir);
    expect(after).toBe(before);
  });

  it('doctor legacy-leftovers paths and count match cleanup detection', async () => {
    await minimalValidConfig(syntaurHome);
    await mkdir(resolve(syntaurHome, 'todos'), { recursive: true });
    await writeFile(resolve(syntaurHome, 'todos/t.txt'), '1');
    await mkdir(resolve(homeDir, '.claude'), { recursive: true });
    await writeFile(
      resolve(homeDir, '.claude/settings.json'),
      JSON.stringify({ enabledPlugins: { syntaur: true } }, null, 2) + '\n',
    );
    await mkdir(resolve(homeDir, '.claude/plugins/syntaur'), { recursive: true });
    await writeInstallMarker(resolve(homeDir, '.claude/plugins/syntaur'));

    const deps = makeDeps(homeDir, syntaurHome);
    const leftovers = await detectLeftovers(deps);
    const reported = leftovers.filter((l) => isActionableLeftover(l));

    const report = await runChecks();
    const check = report.checks.find((c) => c.id === 'structure.legacy-leftovers');
    expect(check?.status).toBe('warn');
    const affected = check?.affected ?? [];
    const countMatch = check?.detail?.match(/^(\d+) leftover/);
    expect(Number(countMatch?.[1])).toBe(reported.length);
    for (const p of affected) {
      expect(reported.some((l) => l.path === p)).toBe(true);
    }
  });

  it('doctor legacy-leftovers detail lists blocked paths and remediation text', async () => {
    await mkdir(resolve(syntaurHome, 'assignments/x'), { recursive: true });
    await writeFile(resolve(syntaurHome, 'assignments/x/a.md'), 'data');
    await writeFile(resolve(syntaurHome, V2_MIGRATED_MARKER), 'rename-ids 2026-01-01T00:00:00.000Z\n');

    const report = await runChecks();
    const check = report.checks.find((c) => c.id === 'structure.legacy-leftovers');
    expect(check?.status).toBe('warn');
    expect(check?.detail).toContain('Blocked:');
    expect(check?.detail).toContain(resolve(syntaurHome, 'assignments'));
    expect(check?.detail).toContain('migrate v2');
    expect(check?.affected).toContain(resolve(syntaurHome, 'assignments'));
  });
});

function retiredRelativeForTest(homeDir: string, absPath: string): string {
  const rel = relative(homeDir, absPath);
  if (rel && !rel.startsWith('..')) return rel;
  return `_abs/${absPath.replace(/^\//, '')}`;
}

function projectsDir(syntaur: string): string {
  return resolve(syntaur, 'projects');
}
