import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileExists } from '../utils/fs.js';
import {
  checkTargetSkillsIntegrity,
  summarizeProblems,
  type SkillProblemKind,
} from '../utils/doctor/checks/cross-agent.js';
import { readSkillIdentity } from '../utils/skill-frontmatter.js';
import {
  KNOWN_SKILLS,
  getSkillsDir,
  discoverSkillNames,
} from '../utils/install-skills.js';
import type { CheckContext } from '../utils/doctor/types.js';

function skillMd(name: string, description = 'A valid description. Use when testing.'): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`;
}

async function writeSkill(root: string, skill: string, content: string): Promise<void> {
  await mkdir(join(root, skill), { recursive: true });
  await writeFile(join(root, skill, 'SKILL.md'), content);
}

describe('checkTargetSkillsIntegrity', () => {
  let canonical: string;
  let installed: string;
  const known = ['alpha', 'beta', 'gamma', 'delta'];

  beforeEach(async () => {
    canonical = await mkdtemp(join(tmpdir(), 'syntaur-canon-'));
    installed = await mkdtemp(join(tmpdir(), 'syntaur-inst-'));
    for (const s of known) await writeSkill(canonical, s, skillMd(s));
  });

  afterEach(async () => {
    await rm(canonical, { recursive: true, force: true });
    await rm(installed, { recursive: true, force: true });
  });

  it('classifies missing / invalid-frontmatter / content-drift and counts valid', async () => {
    // alpha: byte-identical to canonical → valid, no problem
    await writeSkill(installed, 'alpha', skillMd('alpha'));
    // beta: not installed → missing
    // gamma: name mismatch → invalid-frontmatter
    await writeSkill(installed, 'gamma', skillMd('WRONG-NAME'));
    // delta: valid frontmatter but different body → valid + content-drift
    await writeSkill(installed, 'delta', skillMd('delta') + '\nextra drift line\n');

    const res = await checkTargetSkillsIntegrity(installed, canonical, known);

    expect(res.total).toBe(4);
    expect(res.valid).toBe(2); // alpha + delta (delta is frontmatter-valid but drifted)

    const byKind = (kind: SkillProblemKind) =>
      res.problems.filter((p) => p.kind === kind).map((p) => p.skill).sort();
    expect(byKind('missing')).toEqual(['beta']);
    expect(byKind('invalid-frontmatter')).toEqual(['gamma']);
    expect(byKind('content-drift')).toEqual(['delta']);
  });

  it('reports no problems when every skill is present, valid, and in sync', async () => {
    for (const s of known) await writeSkill(installed, s, skillMd(s));
    const res = await checkTargetSkillsIntegrity(installed, canonical, known);
    expect(res.valid).toBe(4);
    expect(res.problems).toEqual([]);
  });

  it('flags an empty description as invalid-frontmatter', async () => {
    await writeSkill(installed, 'alpha', '---\nname: alpha\ndescription:\n---\n');
    const res = await checkTargetSkillsIntegrity(installed, canonical, ['alpha']);
    expect(res.valid).toBe(0);
    expect(res.problems).toEqual([{ skill: 'alpha', kind: 'invalid-frontmatter' }]);
  });

  it('does not flag content-drift when the canonical skill is absent', async () => {
    // installed valid, but canonical has no such skill → drift comparison skipped
    await writeSkill(installed, 'omega', skillMd('omega'));
    const res = await checkTargetSkillsIntegrity(installed, canonical, ['omega']);
    expect(res.valid).toBe(1);
    expect(res.problems).toEqual([]);
  });
});

describe('summarizeProblems', () => {
  it('summarizes counts in a stable order', () => {
    expect(
      summarizeProblems([
        { skill: 'a', kind: 'missing' },
        { skill: 'b', kind: 'missing' },
        { skill: 'c', kind: 'invalid-frontmatter' },
        { skill: 'd', kind: 'content-drift' },
      ]),
    ).toEqual(['2 missing', '1 invalid frontmatter', '1 content drift']);
    expect(summarizeProblems([])).toEqual([]);
  });
});

describe('readSkillIdentity', () => {
  it('reads name + folded description with an internal colon', () => {
    const md = '---\nname: foo\ndescription: >-\n  do a thing for b:xxxx and more\n---\n';
    expect(readSkillIdentity(md)).toEqual({ name: 'foo', hasDescription: true });
  });

  it('returns name=null when there is no frontmatter', () => {
    expect(readSkillIdentity('just text')).toEqual({ name: null, hasDescription: false });
  });

  it('detects a missing description (block indicator with no body)', () => {
    const md = '---\nname: foo\ndescription: >-\n---\nbody';
    expect(readSkillIdentity(md)).toEqual({ name: 'foo', hasDescription: false });
  });

  it('strips quotes around the name', () => {
    expect(readSkillIdentity('---\nname: "foo"\ndescription: x\n---').name).toBe('foo');
  });
});

describe('doctor skill-set source of truth', () => {
  it('every pinned KNOWN_SKILL exists in the canonical skills/ tree (no retired pins)', async () => {
    const discovered = await discoverSkillNames(await getSkillsDir());
    const set = new Set(discovered);
    for (const skill of KNOWN_SKILLS) expect(set.has(skill)).toBe(true);
    // The deepened doctor derives its list from the tree, which must be a
    // superset of the pinned list (the tree has skills KNOWN_SKILLS lags on).
    expect(discovered.length).toBeGreaterThanOrEqual(KNOWN_SKILLS.length);
  });
});

// Run-level tests of the cross-agent.skills check. AGENT_TARGETS captures
// home() paths at import time, so we set HOME to a tmpdir and re-import the
// module fresh (vi.resetModules) for each scenario. We pass a minimal
// CheckContext directly (the check only reads config.integrations.installedAgents
// and cwd) so no real ~/.syntaur is touched.
describe('cross-agent.skills check (run-level)', () => {
  const originalHome = process.env.HOME;
  const originalCodexHome = process.env.CODEX_HOME;
  const originalHermesHome = process.env.HERMES_HOME;
  const originalSyntaurHome = process.env.SYNTAUR_HOME;
  let home: string;
  let cwd: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'syntaur-doctor-home-'));
    cwd = await mkdtemp(join(tmpdir(), 'syntaur-doctor-cwd-'));
    process.env.HOME = home;
    delete process.env.CODEX_HOME;
    delete process.env.HERMES_HOME;
    // syntaurRoot() honors SYNTAUR_HOME over HOME — clear it so user-descriptor
    // resolution reads the isolated HOME, not a real ~/.syntaur from the env.
    delete process.env.SYNTAUR_HOME;
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = originalCodexHome;
    if (originalHermesHome === undefined) delete process.env.HERMES_HOME;
    else process.env.HERMES_HOME = originalHermesHome;
    if (originalSyntaurHome === undefined) delete process.env.SYNTAUR_HOME;
    else process.env.SYNTAUR_HOME = originalSyntaurHome;
    await rm(home, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  });

  async function runCheck(installedAgents: Record<string, { scope: string }>) {
    vi.resetModules();
    const { crossAgentChecks } = await import('../utils/doctor/checks/cross-agent.js');
    const ctx = {
      config: { integrations: { installedAgents } },
      cwd,
    } as unknown as CheckContext;
    return crossAgentChecks[0].run(ctx);
  }

  it('is skipped when no non-native agent is detected or recorded', async () => {
    const res = await runCheck({});
    expect(Array.isArray(res) ? res[0].status : res.status).toBe('skipped');
  });

  it('warns when a recorded agent is missing skills', async () => {
    await mkdir(join(home, '.cursor'), { recursive: true }); // makes cursor detectable
    const res = await runCheck({ cursor: { scope: 'global' } });
    const out = Array.isArray(res) ? res[0] : res;
    expect(out.status).toBe('warn');
    expect(out.detail).toContain('Cursor');
  });

  it('does NOT escalate a detected-but-unrecorded agent (recorded-only escalation)', async () => {
    await mkdir(join(home, '.cursor'), { recursive: true }); // detected, but not recorded
    const res = await runCheck({});
    const out = Array.isArray(res) ? res[0] : res;
    expect(out.status).toBe('pass');
  });

  it('reports Tier-3 absent for a recorded pi without the extension (warn)', async () => {
    const res = await runCheck({ pi: { scope: 'global' } });
    const out = Array.isArray(res) ? res[0] : res;
    expect(out.status).toBe('warn');
    expect(out.detail).toMatch(/Tier-3 pi-extension/);
    expect(out.detail).toMatch(/not installed/);
  });

  it('reports Tier-3 installed when the pi extension entry exists', async () => {
    const extDir = join(home, '.pi', 'agent', 'extensions', 'syntaur');
    await mkdir(extDir, { recursive: true });
    await writeFile(join(extDir, 'index.ts'), '// syntaur pi extension\n');
    const res = await runCheck({ pi: { scope: 'global' } });
    const out = Array.isArray(res) ? res[0] : res;
    expect(out.detail).toMatch(/Tier-3 pi-extension installed/);
  });
});

// Tier-3 plugin install wiring (the copy step), isolated from the full
// `npx skills add` flow. HOME is swapped so installDir resolves under a tmpdir;
// installTier3Plugin's source resolves via findPackageRoot (real platforms/ tree).
describe('tier-3 install (installTier3Plugin)', () => {
  const originalHome = process.env.HOME;
  const originalSyntaurHome = process.env.SYNTAUR_HOME;
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'syntaur-tier3-home-'));
    process.env.HOME = home;
    delete process.env.SYNTAUR_HOME;
  });
  afterEach(async () => {
    process.env.HOME = originalHome;
    if (originalSyntaurHome === undefined) delete process.env.SYNTAUR_HOME;
    else process.env.SYNTAUR_HOME = originalSyntaurHome;
    await rm(home, { recursive: true, force: true });
  });

  it('dry-run prints the action and writes nothing', async () => {
    vi.resetModules();
    const { getAgentTarget } = await import('../targets/registry.js');
    const { installTier3Plugin } = await import('../commands/cross-agent-install.js');
    const pi = getAgentTarget('pi')!;
    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...a) => {
      logs.push(a.map(String).join(' '));
    });
    try {
      await installTier3Plugin(pi, { dryRun: true });
    } finally {
      spy.mockRestore();
    }
    expect(logs.join('\n')).toMatch(/Tier 3 \(pi\): platforms\/pi\/extensions\/syntaur ->/);
    await expect(stat(join(home, '.pi'))).rejects.toThrow();
  });

  it('copies the pi extension into the agent extension dir (non-dry-run)', async () => {
    vi.resetModules();
    const { getAgentTarget } = await import('../targets/registry.js');
    const { installTier3Plugin } = await import('../commands/cross-agent-install.js');
    const pi = getAgentTarget('pi')!;
    await installTier3Plugin(pi, {});
    expect(await fileExists(join(home, '.pi', 'agent', 'extensions', 'syntaur', 'index.ts'))).toBe(
      true,
    );
  });

  it('is idempotent: skips an existing install unless force', async () => {
    vi.resetModules();
    const { getAgentTarget } = await import('../targets/registry.js');
    const { installTier3Plugin } = await import('../commands/cross-agent-install.js');
    const pi = getAgentTarget('pi')!;
    expect(await installTier3Plugin(pi, {})).toBe('installed');
    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...a) => {
      logs.push(a.map(String).join(' '));
    });
    let result: string;
    try {
      result = await installTier3Plugin(pi, {}); // second call → already installed
    } finally {
      spy.mockRestore();
    }
    expect(result).toBe('already-present');
    expect(logs.join('\n')).toMatch(/already installed/);
  });

  it('self-heals an incomplete install dir (dir exists but entry missing)', async () => {
    vi.resetModules();
    const { getAgentTarget } = await import('../targets/registry.js');
    const { installTier3Plugin } = await import('../commands/cross-agent-install.js');
    const pi = getAgentTarget('pi')!;
    // Simulate a prior partial copy: the dir exists, but no index.ts entry.
    const installDir = join(home, '.pi', 'agent', 'extensions', 'syntaur');
    await mkdir(installDir, { recursive: true });
    const result = await installTier3Plugin(pi, {}); // no --force
    expect(result).toBe('installed');
    expect(await fileExists(join(installDir, 'index.ts'))).toBe(true);
  });
});
