import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SKILLS_DIR = resolve(import.meta.dirname, '../../skills');

const EXPECTED_SKILLS = ['done', 'grab', 'log', 'plan', 'syntaur-protocol', 'worktree'] as const;

describe('skill registry', () => {
  it('skills/ contains exactly the six spec skills', () => {
    const dirs = readdirSync(SKILLS_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
    expect(dirs).toEqual([...EXPECTED_SKILLS].sort());
  });

  it('every skills/ directory has SKILL.md with name equal to the directory', () => {
    for (const name of EXPECTED_SKILLS) {
      const skillPath = join(SKILLS_DIR, name, 'SKILL.md');
      const content = readFileSync(skillPath, 'utf-8');
      const match = content.match(/^name:\s*(\S+)\s*$/m);
      expect(match, `${name} missing name frontmatter`).toBeTruthy();
      expect(match![1]).toBe(name);
    }
  });
});
