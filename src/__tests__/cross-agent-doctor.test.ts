import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkTargetSkillsIntegrity,
  summarizeProblems,
  type SkillProblemKind,
} from '../utils/doctor/checks/cross-agent.js';
import { readSkillIdentity } from '../utils/skill-frontmatter.js';

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
