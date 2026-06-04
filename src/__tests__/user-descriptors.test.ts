import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  validateUserDescriptor,
  compileDetect,
  loadUserDescriptors,
  expandHomeAndEnv,
} from '../targets/user-descriptors.js';
import { resolveAgentTargets, resolveAgentTarget } from '../targets/registry.js';

const BUILTINS = new Set(['cursor', 'codex', 'opencode', 'claude', 'pi', 'openclaw', 'hermes']);

const GOOD = {
  id: 'acme',
  displayName: 'Acme Agent',
  skillsShAgentId: 'acme',
  detect: { kind: 'pathExists', path: '~/.acme' },
  skillsDir: { global: '~/.acme/skills' },
  instructions: { files: [{ path: 'AGENTS.md', renderer: 'codexAgents' }] },
};

describe('validateUserDescriptor', () => {
  it('accepts a well-formed descriptor', () => {
    const r = validateUserDescriptor(GOOD, BUILTINS);
    expect(r.ok).toBe(true);
  });

  it.each([
    ['missing id', { ...GOOD, id: undefined }, /id is required/],
    ['bad id chars', { ...GOOD, id: 'Acme!' }, /must match/],
    ['collides with built-in', { ...GOOD, id: 'pi' }, /collides with a built-in/],
    ['missing displayName', { ...GOOD, displayName: '' }, /displayName is required/],
    ['missing detect', { ...GOOD, detect: undefined }, /detect is required/],
    ['bad detect kind', { ...GOOD, detect: { kind: 'wat' } }, /detect.kind must be one of/],
    ['detect.path wrong type', { ...GOOD, detect: { kind: 'pathExists', path: 5 } }, /detect.path must be/],
    [
      'unknown renderer',
      { ...GOOD, instructions: { files: [{ path: 'AGENTS.md', renderer: 'nope' }] } },
      /is not a known renderer/,
    ],
    ['unknown top-level key', { ...GOOD, nativePlugin: 'claude' }, /unknown field "nativePlugin"/],
    ['tier3 smuggling rejected', { ...GOOD, tier3: {} }, /unknown field "tier3"/],
  ])('rejects: %s', (_label, input, pattern) => {
    const r = validateUserDescriptor(input, BUILTINS);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join('; ')).toMatch(pattern);
  });
});

describe('compileDetect', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'syntaur-detect-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('pathExists → true when the path exists, false otherwise', async () => {
    const present = compileDetect({ kind: 'pathExists', path: dir });
    const absent = compileDetect({ kind: 'pathExists', path: join(dir, 'nope') });
    expect(await present()).toBe(true);
    expect(await absent()).toBe(false);
  });

  it('anyPathExists → true if ANY path exists', async () => {
    const fn = compileDetect({ kind: 'anyPathExists', paths: [join(dir, 'nope'), dir] });
    expect(await fn()).toBe(true);
    const none = compileDetect({ kind: 'anyPathExists', paths: [join(dir, 'a'), join(dir, 'b')] });
    expect(await none()).toBe(false);
  });

  it('envSet → honors process.env at call time', async () => {
    const fn = compileDetect({ kind: 'envSet', env: 'SYNTAUR_TEST_DETECT' });
    delete process.env.SYNTAUR_TEST_DETECT;
    expect(await fn()).toBe(false);
    process.env.SYNTAUR_TEST_DETECT = 'x';
    expect(await fn()).toBe(true);
    delete process.env.SYNTAUR_TEST_DETECT;
  });
});

describe('expandHomeAndEnv', () => {
  it('expands ~ and $VAR to an absolute path', () => {
    process.env.SYNTAUR_TEST_VAR = 'acme';
    const out = expandHomeAndEnv('~/.${SYNTAUR_TEST_VAR}/skills');
    expect(out).toMatch(/\/\.acme\/skills$/);
    expect(out.startsWith('/')).toBe(true);
    delete process.env.SYNTAUR_TEST_VAR;
  });
});

describe('loadUserDescriptors', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'syntaur-targets-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('loads good files and warns on bad ones', async () => {
    await writeFile(join(dir, 'acme.json'), JSON.stringify(GOOD));
    await writeFile(join(dir, 'broken.json'), '{ not json');
    await writeFile(join(dir, 'invalid.json'), JSON.stringify({ id: 'x', displayName: 'X' })); // no detect
    const { targets, warnings } = await loadUserDescriptors({ dir, builtinIds: BUILTINS });
    expect(targets.map((t) => t.id)).toEqual(['acme']);
    expect(warnings).toHaveLength(2);
    expect(warnings.join('; ')).toMatch(/broken\.json/);
    expect(warnings.join('; ')).toMatch(/invalid\.json/);
  });

  it('compiles a working detect + absolutizes skillsDir.global', async () => {
    await writeFile(join(dir, 'acme.json'), JSON.stringify(GOOD));
    const { targets } = await loadUserDescriptors({ dir, builtinIds: BUILTINS });
    expect(targets[0].skillsDir?.global?.startsWith('/')).toBe(true);
    expect(targets[0].skillsDir?.global).not.toContain('~');
    expect(typeof (await targets[0].detect())).toBe('boolean');
  });

  it('absent dir → empty, no warnings', async () => {
    const { targets, warnings } = await loadUserDescriptors({
      dir: join(dir, 'does-not-exist'),
      builtinIds: BUILTINS,
    });
    expect(targets).toEqual([]);
    expect(warnings).toEqual([]);
  });
});

describe('resolve* merge (HOME/SYNTAUR_HOME isolated)', () => {
  let home: string;
  const prevSyntaurHome = process.env.SYNTAUR_HOME;
  const prevHome = process.env.HOME;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'syntaur-home-'));
    process.env.HOME = home;
    process.env.SYNTAUR_HOME = join(home, '.syntaur');
    const targetsDir = join(home, '.syntaur', 'targets');
    await mkdir(targetsDir, { recursive: true });
    await writeFile(join(targetsDir, 'acme.json'), JSON.stringify(GOOD));
  });
  afterEach(async () => {
    if (prevSyntaurHome === undefined) delete process.env.SYNTAUR_HOME;
    else process.env.SYNTAUR_HOME = prevSyntaurHome;
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    await rm(home, { recursive: true, force: true });
  });

  it('merges built-ins + user descriptors', async () => {
    const { targets, warnings } = await resolveAgentTargets();
    expect(warnings).toEqual([]);
    const ids = targets.map((t) => t.id);
    expect(ids).toContain('acme');
    expect(ids).toContain('pi');
    expect(await resolveAgentTarget('acme')).toBeDefined();
    expect(await resolveAgentTarget('pi')).toBeDefined();
  });

  it('end-to-end: setup --target acme --dry-run flows through with no code change', async () => {
    const { crossAgentInstallCommand } = await import('../commands/cross-agent-install.js');
    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...a) => {
      logs.push(a.map(String).join(' '));
    });
    try {
      await crossAgentInstallCommand({ target: 'acme', dryRun: true });
    } finally {
      spy.mockRestore();
    }
    const out = logs.join('\n');
    expect(out).toMatch(/Tier 1 \(skills\): npx skills add prong-horn\/syntaur --agent acme/);
    expect(out).toMatch(/Tier 2 \(acme\):.*AGENTS\.md/);
  });
});
