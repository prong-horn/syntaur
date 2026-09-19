import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runChecks } from '../utils/doctor/index.js';
import { installHooksCommand } from '../commands/hooks.js';
import { SYNTAUR_PACK_SKILL_NAMES } from '../utils/doctor/checks/skills.js';

const here = dirname(fileURLToPath(import.meta.url));
let home: string;
let syntaurDir: string;
let claudeDir: string;
const originalHome = process.env.HOME;

function byId(report: Awaited<ReturnType<typeof runChecks>>, id: string) {
  return report.checks.filter((c) => c.id === id);
}

async function initBaseline(): Promise<void> {
  await mkdir(syntaurDir, { recursive: true });
  await mkdir(join(syntaurDir, 'projects'), { recursive: true });
  await mkdir(join(syntaurDir, 'playbooks'), { recursive: true });
  await writeFile(
    join(syntaurDir, 'config.md'),
    `---\nversion: "1.0"\ndefaultProjectDir: ${join(syntaurDir, 'projects')}\n---\n`,
  );
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'syntaur-doctor-hooks-'));
  syntaurDir = join(home, '.syntaur');
  claudeDir = join(home, '.claude');
  process.env.HOME = home;
  delete process.env.SYNTAUR_HOME;
});

afterEach(async () => {
  process.env.HOME = originalHome;
  await rm(home, { recursive: true, force: true });
});

describe('hooks.installed', () => {
  it('skips when ~/.claude is absent', async () => {
    await initBaseline();
    const report = await runChecks();
    expect(byId(report, 'hooks.installed')[0]?.status).toBe('skipped');
  });

  it('warns when hooks are not installed', async () => {
    await initBaseline();
    await mkdir(claudeDir, { recursive: true });
    await writeFile(join(claudeDir, 'settings.json'), '{}\n', 'utf-8');
    const report = await runChecks();
    expect(byId(report, 'hooks.installed')[0]?.status).toBe('warn');
    expect(byId(report, 'hooks.installed')[0]?.detail).toContain('not installed');
  });

  it('passes when hooks are installed and match the package', async () => {
    await initBaseline();
    await mkdir(claudeDir, { recursive: true });
    const settingsPath = join(claudeDir, 'settings.json');
    await installHooksCommand({ settingsPath, installRoot: syntaurDir });
    const report = await runChecks();
    expect(byId(report, 'hooks.installed')[0]?.status).toBe('pass');
  });

  it('warns on script drift', async () => {
    await initBaseline();
    await mkdir(claudeDir, { recursive: true });
    const settingsPath = join(claudeDir, 'settings.json');
    await installHooksCommand({ settingsPath, installRoot: syntaurDir });
    await writeFile(join(syntaurDir, 'hooks', 'session-start.sh'), '# mutated\n', 'utf-8');
    const report = await runChecks();
    expect(byId(report, 'hooks.installed')[0]?.status).toBe('warn');
    expect(byId(report, 'hooks.installed')[0]?.detail).toMatch(/drift/i);
  });

  it('warns when the syntaur plugin is still enabled', async () => {
    await initBaseline();
    await mkdir(claudeDir, { recursive: true });
    const settingsPath = join(claudeDir, 'settings.json');
    await installHooksCommand({ settingsPath, installRoot: syntaurDir });
    const settings = JSON.parse(await readFile(settingsPath, 'utf-8'));
    settings.enabledPlugins = { 'syntaur@user-plugins': true };
    await writeFile(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
    const report = await runChecks();
    expect(byId(report, 'hooks.installed')[0]?.status).toBe('warn');
    expect(byId(report, 'hooks.installed')[0]?.detail).toContain('plugin is still enabled');
  });
});

describe('skills.installed', () => {
  it('skips without ~/.claude', async () => {
    await initBaseline();
    const report = await runChecks();
    expect(byId(report, 'skills.installed')[0]?.status).toBe('skipped');
  });

  it('warns when skills are missing', async () => {
    await initBaseline();
    await mkdir(join(claudeDir, 'skills'), { recursive: true });
    await mkdir(claudeDir, { recursive: true });
    const report = await runChecks();
    expect(byId(report, 'skills.installed')[0]?.status).toBe('warn');
  });

  it('passes when all six exist (symlink counts)', async () => {
    await initBaseline();
    await mkdir(claudeDir, { recursive: true });
    const skillsDir = join(claudeDir, 'skills');
    await mkdir(skillsDir, { recursive: true });
    for (const name of SYNTAUR_PACK_SKILL_NAMES) {
      const link = join(skillsDir, name);
      await mkdir(link, { recursive: true });
      await writeFile(join(link, 'SKILL.md'), `---\nname: ${name}\n---\n`, 'utf-8');
    }
    const report = await runChecks();
    const skillsCheck = byId(report, 'skills.installed')[0];
    expect(skillsCheck?.status, skillsCheck?.detail).toBe('pass');
  });
});
