import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
// The generator is a dependency-free ESM script; import its pure exports.
import {
  SCHEMA_URI,
  buildSkillsIndex,
  parseSkillFrontmatter,
  listSkillDirs,
} from '../../scripts/build-skills-index.mjs';

const SKILLS_DIR = fileURLToPath(new URL('../../skills', import.meta.url));
const DIGEST_RE = /^sha256:[a-f0-9]{64}$/;

interface SkillEntry {
  name: string;
  type: 'skill-md' | 'archive';
  description: string;
  url: string;
  digest: string;
}
interface Index {
  $schema: string;
  skills: SkillEntry[];
}

async function build(): Promise<{ outDir: string; index: Index }> {
  const outDir = await mkdtemp(join(tmpdir(), 'syntaur-skills-index-'));
  await buildSkillsIndex({ skillsDir: SKILLS_DIR, outDir });
  const index = JSON.parse(await readFile(join(outDir, 'index.json'), 'utf-8')) as Index;
  return { outDir, index };
}

describe('build-skills-index generator', () => {
  let outDir: string;
  let index: Index;

  beforeAll(async () => {
    ({ outDir, index } = await build());
  });

  it('emits the exact v0.2.0 $schema and a non-empty skills array', () => {
    expect(index.$schema).toBe('https://schemas.agentskills.io/discovery/0.2.0/schema.json');
    expect(SCHEMA_URI).toBe(index.$schema);
    expect(Array.isArray(index.skills)).toBe(true);
    expect(index.skills.length).toBeGreaterThan(0);
  });

  it('every entry has spec-valid name/type/description/url/digest', () => {
    for (const s of index.skills) {
      expect(typeof s.name).toBe('string');
      expect(s.name.length).toBeGreaterThan(0);
      expect(['skill-md', 'archive']).toContain(s.type);
      expect(typeof s.description).toBe('string');
      expect(s.description.length).toBeGreaterThan(0);
      expect(s.description.length).toBeLessThanOrEqual(1024);
      expect(s.digest).toMatch(DIGEST_RE);
      // index-directory-relative url: no leading slash, no scheme.
      expect(s.url.startsWith('/')).toBe(false);
      expect(/^[a-z][a-z0-9+.-]*:\/\//i.test(s.url)).toBe(false);
      expect(s.url).toBe(s.type === 'archive' ? `${s.name}.tar.gz` : `${s.name}/SKILL.md`);
    }
  });

  it('digests match the bytes of the written artifacts (verifiable under skills.sh)', async () => {
    for (const s of index.skills) {
      const bytes = await readFile(join(outDir, s.url));
      const got = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
      expect(got).toBe(s.digest);
    }
  });

  it('covers every skills/ dir exactly once with name === dir', async () => {
    const dirs = await listSkillDirs(SKILLS_DIR);
    const names = index.skills.map((s) => s.name).sort();
    expect(names).toEqual([...dirs].sort());
    expect(new Set(names).size).toBe(names.length); // no dupes
  });

  it('classifies syntaur-protocol (multi-file) as archive and single-file skills as skill-md', async () => {
    const protocol = index.skills.find((s) => s.name === 'syntaur-protocol');
    expect(protocol?.type).toBe('archive');
    // Spot-check a couple of single-file skills.
    for (const name of ['add-memory', 'grab-assignment']) {
      expect(index.skills.find((s) => s.name === name)?.type).toBe('skill-md');
    }
  });

  it('regenerates deterministically (byte-identical index.json + archive)', async () => {
    const a = await mkdtemp(join(tmpdir(), 'syntaur-skills-det-a-'));
    const b = await mkdtemp(join(tmpdir(), 'syntaur-skills-det-b-'));
    await buildSkillsIndex({ skillsDir: SKILLS_DIR, outDir: a });
    await buildSkillsIndex({ skillsDir: SKILLS_DIR, outDir: b });
    expect(await readFile(join(a, 'index.json'))).toEqual(await readFile(join(b, 'index.json')));
    expect(await readFile(join(a, 'syntaur-protocol.tar.gz'))).toEqual(
      await readFile(join(b, 'syntaur-protocol.tar.gz')),
    );
    await rm(a, { recursive: true, force: true });
    await rm(b, { recursive: true, force: true });
  });

  it('produces a standard tar.gz with a root SKILL.md extractable by system tar', async () => {
    const extractDir = await mkdtemp(join(tmpdir(), 'syntaur-skills-extract-'));
    execFileSync('tar', ['-xzf', join(outDir, 'syntaur-protocol.tar.gz'), '-C', extractDir]);
    const top = await readdir(extractDir);
    expect(top).toContain('SKILL.md'); // root SKILL.md is required by skills.sh
    expect(top).toContain('references');
    await rm(extractDir, { recursive: true, force: true });
  });
});

describe('parseSkillFrontmatter', () => {
  it('reads a plain inline name + folded >- description (with an internal colon)', () => {
    const md = [
      '---',
      'name: bundle-worktree',
      'description: >-',
      '  Create a git worktree for a bundle. Use when you want to',
      '  "spin up a workspace for bundle b:xxxx" or work in parallel.',
      'license: MIT',
      '---',
      'body',
    ].join('\n');
    const { name, description } = parseSkillFrontmatter(md);
    expect(name).toBe('bundle-worktree');
    expect(description).toContain('b:xxxx'); // colon inside the folded body survives
    expect(description).not.toContain('\n'); // folded → single line
  });

  it('reads a quoted name + inline description', () => {
    const md = ['---', 'name: "foo-bar"', 'description: A short one.', '---'].join('\n');
    const { name, description } = parseSkillFrontmatter(md);
    expect(name).toBe('foo-bar');
    expect(description).toBe('A short one.');
  });

  it('reads a literal |- description preserving newlines', () => {
    const md = ['---', 'name: lit', 'description: |-', '  line one', '  line two', '---'].join('\n');
    const { description } = parseSkillFrontmatter(md);
    expect(description).toBe('line one\nline two');
  });

  it('throws when name or description is missing', () => {
    expect(() => parseSkillFrontmatter('---\nname: x\n---')).toThrow();
    expect(() => parseSkillFrontmatter('no frontmatter')).toThrow();
  });
});
