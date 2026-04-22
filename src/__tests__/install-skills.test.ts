import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
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
const realSourceDir = resolve(repoRoot, 'vendor', 'syntaur-skills', 'skills');

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

  it('installs all skills into an empty target dir', async () => {
    const results = await installSkills({
      target: 'claude',
      sourceDir: realSourceDir,
      targetDir,
    });

    expect(results).toHaveLength(KNOWN_SKILLS.length);
    for (const r of results) {
      expect(r.status).toBe('installed');
    }

    // Each skill dir exists with SKILL.md.
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

    // User edits one skill.
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

    // Content is untouched.
    const after = await readFile(edited, 'utf-8');
    expect(after).toContain('# user-local edit');

    // Other skills still report already-current.
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
    ).rejects.toThrow(/Vendored skills not found/);
  });

  it('works for codex target dir', async () => {
    const codexTarget = join(sandbox, 'codex-skills');
    const results = await installSkills({
      target: 'codex',
      sourceDir: realSourceDir,
      targetDir: codexTarget,
    });
    expect(results.every((r) => r.status === 'installed')).toBe(true);
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

    const removed = await uninstallSkills({ target: 'claude', targetDir });
    expect(removed).toHaveLength(KNOWN_SKILLS.length);

    for (const skill of KNOWN_SKILLS) {
      const skillDir = join(targetDir, skill);
      await expect(readFile(join(skillDir, 'SKILL.md'))).rejects.toThrow();
    }
  });

  it('does not remove a user-authored skill with a matching directory name', async () => {
    // Create a dir called `grab-assignment` with a SKILL.md whose `name:` field
    // is something else — simulating a user's custom skill that happens to
    // collide with our skill dir name.
    const imposter = join(targetDir, 'grab-assignment');
    await mkdir(imposter, { recursive: true });
    await writeFile(
      join(imposter, 'SKILL.md'),
      '---\nname: my-custom-skill\ndescription: mine\n---\n\n# Mine\n',
      'utf-8',
    );

    const removed = await uninstallSkills({ target: 'claude', targetDir });
    expect(removed).toHaveLength(0);

    const stillThere = await readFile(join(imposter, 'SKILL.md'), 'utf-8');
    expect(stillThere).toContain('name: my-custom-skill');
  });

  it('no-ops on a non-existent target dir', async () => {
    const removed = await uninstallSkills({
      target: 'claude',
      targetDir: join(sandbox, 'does-not-exist'),
    });
    expect(removed).toEqual([]);
  });
});
