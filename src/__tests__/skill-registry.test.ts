import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { KNOWN_SKILLS } from '../utils/install-skills.js';

const REPO_ROOT = resolve(import.meta.dirname, '../..');
const SKILLS_DIR = join(REPO_ROOT, 'skills');

function skillDirsOnDisk(): string[] {
  return readdirSync(SKILLS_DIR)
    .filter((name) => statSync(join(SKILLS_DIR, name)).isDirectory())
    .filter((name) => statSync(join(SKILLS_DIR, name, 'SKILL.md')).isFile())
    .sort();
}

function manifestSkillNames(manifestPath: string): string[] {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as {
    skills: string[];
  };
  return manifest.skills
    .map((entry) => entry.replace(/^\.\/skills\//, ''))
    .sort();
}

function symmetricDiff(a: string[], b: string[]): string[] {
  const setB = new Set(b);
  const setA = new Set(a);
  return [...a.filter((x) => !setB.has(x)), ...b.filter((x) => !setA.has(x))].sort();
}

describe('skill registry', () => {
  it('keeps skills/, both manifests, and KNOWN_SKILLS in sync', () => {
    const onDisk = skillDirsOnDisk();
    const topManifest = manifestSkillNames(join(REPO_ROOT, '.claude-plugin/plugin.json'));
    const claudeManifest = manifestSkillNames(
      join(REPO_ROOT, 'platforms/claude-code/.claude-plugin/plugin.json'),
    );
    const known = [...KNOWN_SKILLS].sort();

    const sets = [onDisk, topManifest, claudeManifest, known];
    for (let i = 1; i < sets.length; i++) {
      const diff = symmetricDiff(sets[0], sets[i]);
      expect(diff, `mismatch vs ${i === 1 ? 'top manifest' : i === 2 ? 'claude manifest' : 'KNOWN_SKILLS'}: ${diff.join(', ')}`).toEqual([]);
    }
  });

  it('uses directory names in SKILL.md frontmatter name:', () => {
    for (const dir of skillDirsOnDisk()) {
      const content = readFileSync(join(SKILLS_DIR, dir, 'SKILL.md'), 'utf-8');
      const match = content.match(/^name:\s*(\S+)\s*$/m);
      expect(match?.[1], `${dir}/SKILL.md frontmatter name`).toBe(dir);
    }
  });
});
