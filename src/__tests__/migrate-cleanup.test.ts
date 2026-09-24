import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { isSyntaurPluginKey } from '../utils/claude-plugin-key.js';
import { KNOWN_TOP_LEVEL } from '../utils/doctor/checks/structure.js';
import { SYNTAUR_PACK_SKILL_NAMES } from '../utils/doctor/checks/skills.js';
import { runChecks } from '../utils/doctor/index.js';
import {
  RETIRED_HOME_ENTRIES,
  RETIRED_SKILL_NAMES,
  detectLeftovers,
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

function makeDeps(
  homeDir: string,
  syntaurHome: string,
  opts?: { platform?: NodeJS.Platform; runner?: CleanupDeps['runner']; tmpDir?: string },
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
    const before = await treeHash(homeDir);
    const { lines } = await runMigrateCleanup({}, makeDeps(homeDir, syntaurHome));
    expect(lines.some((l) => l.includes('syntaur@user-plugins'))).toBe(true);
    expect(lines.some((l) => l.includes('syntaur-demos'))).toBe(false);
    expect(await treeHash(homeDir)).toBe(before);
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
    await runMigrateCleanup({ apply: true }, makeDeps(homeDir, syntaurHome, { runner }));
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
});

function projectsDir(syntaur: string): string {
  return resolve(syntaur, 'projects');
}
