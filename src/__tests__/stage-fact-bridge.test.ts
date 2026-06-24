import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { assertStageFactOnOpen } from '../lifecycle/stage-fact-bridge.js';
import { parseAssignmentFrontmatter } from '../lifecycle/frontmatter.js';

let home: string;
let prevHome: string | undefined;
const PROJECT = 'proj';
const SLUG = 'asg';
const ID = '12345678-1234-4234-8234-123456789abc';
let asgPath: string;
let PROJDIR: string;

async function writeAssignment(overrides: Record<string, string> = {}): Promise<void> {
  const fm = {
    id: ID,
    slug: SLUG,
    title: '"T"',
    project: PROJECT,
    status: 'in_progress',
    phase: 'in_progress',
    disposition: 'active',
    planApproval: 'null',
    parked: 'false',
    reviewRequested: 'false',
    reworkRequested: 'false',
    implementationStarted: 'false',
    ...overrides,
  };
  const lines = Object.entries(fm).map(([k, v]) => `${k}: ${v}`).join('\n');
  await writeFile(
    asgPath,
    `---\n${lines}\n---\n\n# T\n\n## Acceptance Criteria\n\n- [ ] one\n- [ ] two\n`,
    'utf-8',
  );
}

async function fm() {
  return parseAssignmentFrontmatter(await readFile(asgPath, 'utf-8'));
}
function historyCount(content: string): number {
  return (content.match(/^  - at:/gm) ?? []).length;
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'syntaur-sfb-'));
  prevHome = process.env.SYNTAUR_HOME;
  process.env.SYNTAUR_HOME = home;
  const dir = resolve(home, 'projects', PROJECT, 'assignments', SLUG);
  await mkdir(dir, { recursive: true });
  asgPath = resolve(dir, 'assignment.md');
  PROJDIR = resolve(home, 'projects', PROJECT);
  await writeAssignment();
});

afterEach(async () => {
  if (prevHome === undefined) delete process.env.SYNTAUR_HOME;
  else process.env.SYNTAUR_HOME = prevHome;
  await rm(home, { recursive: true, force: true });
});

describe('assertStageFactOnOpen', () => {
  it('implement stage asserts implementationStarted', async () => {
    await assertStageFactOnOpen({ assignmentPath: asgPath, projectDir: PROJDIR, stage: 'implement', by: 'agent:claude' });
    expect((await fm()).implementationStarted).toBe(true);
  });

  it('is a no-op when the fact is already true (no recompute / no new history entry)', async () => {
    await writeAssignment({ implementationStarted: 'true' });
    const before = historyCount(await readFile(asgPath, 'utf-8'));
    await assertStageFactOnOpen({ assignmentPath: asgPath, projectDir: PROJDIR, stage: 'implement' });
    const after = historyCount(await readFile(asgPath, 'utf-8'));
    expect(after).toBe(before); // AC4: no fact delta → no write
    expect((await fm()).implementationStarted).toBe(true);
  });

  it('review stage asserts reviewRequested and clears reworkRequested', async () => {
    await writeAssignment({ reworkRequested: 'true', implementationStarted: 'true' });
    await assertStageFactOnOpen({ assignmentPath: asgPath, projectDir: PROJDIR, stage: 'review' });
    const f = await fm();
    expect(f.reviewRequested).toBe(true);
    expect(f.reworkRequested).toBe(false);
  });

  it('implement after review (prevStage=review) asserts reworkRequested', async () => {
    await writeAssignment({ implementationStarted: 'true', reviewRequested: 'true', phase: 'review' });
    await assertStageFactOnOpen({ assignmentPath: asgPath, projectDir: PROJDIR, prevStage: 'review', stage: 'implement' });
    expect((await fm()).reworkRequested).toBe(true);
  });

  it('does not assert rework on a plain implement (no prior review)', async () => {
    await writeAssignment({ implementationStarted: 'true' });
    await assertStageFactOnOpen({ assignmentPath: asgPath, projectDir: PROJDIR, prevStage: 'plan', stage: 'implement' });
    expect((await fm()).reworkRequested).toBe(false);
  });

  it('throws on a terminal assignment (facts frozen) instead of silently succeeding', async () => {
    await writeAssignment({ status: 'completed' });
    await expect(
      assertStageFactOnOpen({ assignmentPath: asgPath, projectDir: PROJDIR, stage: 'implement' }),
    ).rejects.toThrow(/terminal/i);
  });

  it('no-ops (no throw) when the assignment path does not exist', async () => {
    await expect(
      assertStageFactOnOpen({ assignmentPath: resolve(home, 'nope', 'assignment.md'), projectDir: null, stage: 'implement' }),
    ).resolves.toBeUndefined();
  });
});
