import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, readFile, readdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  installSkills,
  uninstallSkills,
  KNOWN_SKILLS,
} from '../utils/install-skills.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const realSourceDir = resolve(repoRoot, 'skills');

describe('installSkills', () => {
  let sandbox: string;
  let targetDir: string;

  beforeEach(async () => {
    sandbox = await mkdtemp(join(tmpdir(), 'syntaur-install-skills-'));
    targetDir = join(sandbox, 'skills');
  });

  afterEach(async () => {
    await rm(sandbox, { recursive: true, force: true });
  });

  it('installs all skills from <repo>/skills/ into an empty target', async () => {
    const results = await installSkills({
      target: 'claude',
      sourceDir: realSourceDir,
      targetDir,
    });

    expect(results.length).toBeGreaterThan(0);
    for (const skill of KNOWN_SKILLS) {
      const r = results.find((res) => res.skill === skill);
      expect(r, `expected ${skill} in install results`).toBeDefined();
      expect(r?.status).toBe('installed');
    }

    for (const skill of KNOWN_SKILLS) {
      const skillMd = join(targetDir, skill, 'SKILL.md');
      const content = await readFile(skillMd, 'utf-8');
      expect(content).toContain(`name: ${skill}`);
    }
  });

  it('is idempotent — re-running reports already-current', async () => {
    await installSkills({
      target: 'claude',
      sourceDir: realSourceDir,
      targetDir,
    });

    const second = await installSkills({
      target: 'claude',
      sourceDir: realSourceDir,
      targetDir,
    });

    for (const r of second) {
      expect(r.status).toBe('already-current');
    }
  });

  it('preserves user-edited skills without --force', async () => {
    await installSkills({
      target: 'claude',
      sourceDir: realSourceDir,
      targetDir,
    });

    const edited = join(targetDir, 'grab-assignment', 'SKILL.md');
    const original = await readFile(edited, 'utf-8');
    await writeFile(edited, original + '\n# user-local edit\n', 'utf-8');

    const results = await installSkills({
      target: 'claude',
      sourceDir: realSourceDir,
      targetDir,
    });

    const grab = results.find((r) => r.skill === 'grab-assignment');
    expect(grab?.status).toBe('differs-preserved');

    const after = await readFile(edited, 'utf-8');
    expect(after).toContain('# user-local edit');

    const others = results.filter((r) => r.skill !== 'grab-assignment');
    for (const r of others) {
      expect(r.status).toBe('already-current');
    }
  });

  it('overwrites user-edited skills with force=true', async () => {
    await installSkills({
      target: 'claude',
      sourceDir: realSourceDir,
      targetDir,
    });

    const edited = join(targetDir, 'grab-assignment', 'SKILL.md');
    const original = await readFile(edited, 'utf-8');
    await writeFile(edited, original + '\n# user-local edit\n', 'utf-8');

    const results = await installSkills({
      target: 'claude',
      sourceDir: realSourceDir,
      targetDir,
      force: true,
    });

    const grab = results.find((r) => r.skill === 'grab-assignment');
    expect(grab?.status).toBe('overwritten');

    const after = await readFile(edited, 'utf-8');
    expect(after).not.toContain('# user-local edit');
  });

  it('rejects a missing source dir with a clear message', async () => {
    const bogus = join(sandbox, 'nonexistent');
    await expect(
      installSkills({
        target: 'claude',
        sourceDir: bogus,
        targetDir,
      }),
    ).rejects.toThrow(/Syntaur skills not found/);
  });

  it('works for codex target dir (no platform-specific carve-out)', async () => {
    const codexTarget = join(sandbox, 'codex-skills');
    const results = await installSkills({
      target: 'codex',
      sourceDir: realSourceDir,
      targetDir: codexTarget,
    });
    // Same skill set goes to both targets; the per-agent skills.sh CLI
    // would dispatch to per-agent dirs, but for the syntaur CLI the
    // target dir is the only difference.
    for (const skill of KNOWN_SKILLS) {
      const r = results.find((res) => res.skill === skill);
      expect(r?.status).toBe('installed');
    }
  });

  it('copies nested files (references/) for syntaur-protocol', async () => {
    await installSkills({
      target: 'claude',
      sourceDir: realSourceDir,
      targetDir,
    });

    const references = join(targetDir, 'syntaur-protocol', 'references');
    const files = await readdir(references);
    expect(files).toContain('file-ownership.md');
    expect(files).toContain('protocol-summary.md');
  });

  it('discovers extra skills in the source dir beyond the pinned list', async () => {
    // Build a fake source dir with the protocol skill (pinned) plus an extra
    // user-authored skill — discovery must include the extra.
    const customSource = join(sandbox, 'custom-source');
    const protocolDir = join(customSource, 'syntaur-protocol');
    await mkdir(protocolDir, { recursive: true });
    await writeFile(
      join(protocolDir, 'SKILL.md'),
      '---\nname: syntaur-protocol\ndescription: minimal\n---\n',
      'utf-8',
    );
    const extraDir = join(customSource, 'my-extra');
    await mkdir(extraDir, { recursive: true });
    await writeFile(
      join(extraDir, 'SKILL.md'),
      '---\nname: my-extra\ndescription: extra\n---\n',
      'utf-8',
    );

    const results = await installSkills({
      target: 'claude',
      sourceDir: customSource,
      targetDir,
    });

    expect(results.find((r) => r.skill === 'syntaur-protocol')).toBeDefined();
    expect(results.find((r) => r.skill === 'my-extra')?.status).toBe('installed');
  });

  it('skips dirs without SKILL.md (treats them as not skills)', async () => {
    const customSource = join(sandbox, 'mixed-source');
    const realSkill = join(customSource, 'real');
    await mkdir(realSkill, { recursive: true });
    await writeFile(
      join(realSkill, 'SKILL.md'),
      '---\nname: real\ndescription: real\n---\n',
      'utf-8',
    );
    const fakeDir = join(customSource, 'not-a-skill');
    await mkdir(fakeDir, { recursive: true });
    await writeFile(join(fakeDir, 'README.md'), '# not a skill\n', 'utf-8');

    const results = await installSkills({
      target: 'claude',
      sourceDir: customSource,
      targetDir,
    });

    expect(results).toHaveLength(1);
    expect(results[0]?.skill).toBe('real');
  });

  it('skips a target that is a symlink (managed by skills.sh)', async () => {
    // Pre-create a symlink at one of the skill targets — installSkills
    // must NOT overwrite it.
    const customSource = join(sandbox, 'one-skill');
    const skillSrc = join(customSource, 'grab-assignment');
    await mkdir(skillSrc, { recursive: true });
    await writeFile(
      join(skillSrc, 'SKILL.md'),
      '---\nname: grab-assignment\ndescription: from syntaur\n---\n',
      'utf-8',
    );

    // Simulate skills.sh symlink target — point to some unrelated dir.
    const externalCanonical = join(sandbox, 'skills-sh-cache', 'grab-assignment');
    await mkdir(externalCanonical, { recursive: true });
    await writeFile(
      join(externalCanonical, 'SKILL.md'),
      '---\nname: grab-assignment\ndescription: from skills.sh\n---\n',
      'utf-8',
    );

    await mkdir(targetDir, { recursive: true });
    await symlink(externalCanonical, join(targetDir, 'grab-assignment'));

    const results = await installSkills({
      target: 'claude',
      sourceDir: customSource,
      targetDir,
    });

    const grab = results.find((r) => r.skill === 'grab-assignment');
    expect(grab?.status).toBe('skipped-symlink');

    // Verify the symlink was not touched.
    const fromSymlink = await readFile(
      join(targetDir, 'grab-assignment', 'SKILL.md'),
      'utf-8',
    );
    expect(fromSymlink).toContain('description: from skills.sh');
  });
});

describe('uninstallSkills', () => {
  let sandbox: string;
  let targetDir: string;

  beforeEach(async () => {
    sandbox = await mkdtemp(join(tmpdir(), 'syntaur-uninstall-skills-'));
    targetDir = join(sandbox, 'skills');
  });

  afterEach(async () => {
    await rm(sandbox, { recursive: true, force: true });
  });

  it('removes installed protocol skills', async () => {
    await installSkills({
      target: 'claude',
      sourceDir: realSourceDir,
      targetDir,
    });

    const removed = await uninstallSkills({
      target: 'claude',
      targetDir,
      sourceDir: realSourceDir,
    });
    expect(removed.length).toBeGreaterThanOrEqual(KNOWN_SKILLS.length);

    for (const skill of KNOWN_SKILLS) {
      const skillDir = join(targetDir, skill);
      await expect(readFile(join(skillDir, 'SKILL.md'))).rejects.toThrow();
    }
  });

  it('does not remove a user-authored skill with a matching directory name', async () => {
    const imposter = join(targetDir, 'grab-assignment');
    await mkdir(imposter, { recursive: true });
    await writeFile(
      join(imposter, 'SKILL.md'),
      '---\nname: my-custom-skill\ndescription: mine\n---\n\n# Mine\n',
      'utf-8',
    );

    const removed = await uninstallSkills({
      target: 'claude',
      targetDir,
      sourceDir: realSourceDir,
    });
    expect(removed).toHaveLength(0);

    const stillThere = await readFile(join(imposter, 'SKILL.md'), 'utf-8');
    expect(stillThere).toContain('name: my-custom-skill');
  });

  it('does not remove a skills.sh-managed symlink', async () => {
    const externalCanonical = join(sandbox, 'skills-sh-cache', 'grab-assignment');
    await mkdir(externalCanonical, { recursive: true });
    await writeFile(
      join(externalCanonical, 'SKILL.md'),
      '---\nname: grab-assignment\ndescription: external\n---\n',
      'utf-8',
    );
    await mkdir(targetDir, { recursive: true });
    await symlink(externalCanonical, join(targetDir, 'grab-assignment'));

    const removed = await uninstallSkills({
      target: 'claude',
      targetDir,
      sourceDir: realSourceDir,
    });
    expect(removed).not.toContain(join(targetDir, 'grab-assignment'));

    // Symlink and target should still exist.
    const fromSymlink = await readFile(
      join(targetDir, 'grab-assignment', 'SKILL.md'),
      'utf-8',
    );
    expect(fromSymlink).toContain('description: external');
  });

  it('no-ops on a non-existent target dir', async () => {
    const removed = await uninstallSkills({
      target: 'claude',
      targetDir: join(sandbox, 'does-not-exist'),
      sourceDir: realSourceDir,
    });
    expect(removed).toEqual([]);
  });
});
