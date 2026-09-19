import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SKILLS_DIR = resolve(import.meta.dirname, '../../skills');

describe('skill registry', () => {
  it('every skills/ directory has SKILL.md with name equal to the directory', () => {
    const dirs = readdirSync(SKILLS_DIR, { withFileTypes: true }).filter((e) => e.isDirectory());
    expect(dirs.length).toBeGreaterThan(0);
    for (const dir of dirs) {
      const skillPath = join(SKILLS_DIR, dir.name, 'SKILL.md');
      const content = readFileSync(skillPath, 'utf-8');
      const match = content.match(/^name:\s*(\S+)\s*$/m);
      expect(match, `${dir.name} missing name frontmatter`).toBeTruthy();
      expect(match![1]).toBe(dir.name);
    }
  });
});
