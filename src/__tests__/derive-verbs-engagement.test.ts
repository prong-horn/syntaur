import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import {
  initSessionDb,
  closeSessionDb,
  resetSessionDb,
} from '../dashboard/session-db.js';
import { openEngagement, getOpenEngagement } from '../db/engagement-db.js';
import { setCumulativeTokenSource } from '../db/engagement-tokens.js';
import { implementStartedCommand, requestReviewCommand } from '../commands/derive-verbs.js';
import { parseAssignmentFrontmatter } from '../lifecycle/frontmatter.js';

let home: string;
let prevHome: string | undefined;
let prevSid: string | undefined;
const SESSION = 'sess-int';
const ID_A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const ID_B = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';

async function writeAssignment(slug: string, id: string, extra: Record<string, string> = {}): Promise<string> {
  const dir = resolve(home, 'projects', 'p', 'assignments', slug);
  await mkdir(dir, { recursive: true });
  const fm = {
    id, slug, title: '"T"', project: 'p', status: 'in_progress', phase: 'in_progress',
    disposition: 'active', planApproval: 'null', parked: 'false', reviewRequested: 'false',
    reworkRequested: 'false', implementationStarted: 'false', assignee: 'null', ...extra,
  };
  const path = resolve(dir, 'assignment.md');
  await writeFile(path, `---\n${Object.entries(fm).map(([k, v]) => `${k}: ${v}`).join('\n')}\n---\n\n# T\n\n## Acceptance Criteria\n\n- [ ] one\n`, 'utf-8');
  return path;
}
async function fmOf(path: string) {
  return parseAssignmentFrontmatter(await readFile(path, 'utf-8'));
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'syntaur-dve-'));
  prevHome = process.env.SYNTAUR_HOME;
  prevSid = process.env.CLAUDE_CODE_SESSION_ID;
  process.env.SYNTAUR_HOME = home;
  process.env.CLAUDE_CODE_SESSION_ID = SESSION; // STRONG provenance
  resetSessionDb();
  initSessionDb(resolve(home, 'syntaur.db'));
  setCumulativeTokenSource(async () => ({ models: {}, collectorRunAt: null, capturedAt: '2026-03-26T10:00:00Z' }));
});
afterEach(async () => {
  setCumulativeTokenSource(null);
  closeSessionDb();
  if (prevHome === undefined) delete process.env.SYNTAUR_HOME; else process.env.SYNTAUR_HOME = prevHome;
  if (prevSid === undefined) delete process.env.CLAUDE_CODE_SESSION_ID; else process.env.CLAUDE_CODE_SESSION_ID = prevSid;
  await rm(home, { recursive: true, force: true });
});

describe('implement/review verbs drive engagement stage + facts (session-backed)', () => {
  it('implement switches the session engagement and asserts implementationStarted', async () => {
    const pathB = await writeAssignment('b', ID_B);
    await implementStartedCommand('b', { project: 'p', dir: resolve(home, 'projects'), cwd: home });
    expect((await fmOf(pathB)).implementationStarted).toBe(true);
    const open = getOpenEngagement(SESSION);
    expect(open?.stage).toBe('implement');
    expect(open?.assignment_id).toBe(ID_B);
  });

  it('does NOT mark assignment B as rework when the session was reviewing a DIFFERENT assignment A', async () => {
    await writeAssignment('a', ID_A, { implementationStarted: 'true', reviewRequested: 'true', phase: 'review' });
    const pathB = await writeAssignment('b', ID_B);
    // session currently has an OPEN review engagement on A
    openEngagement({ sessionId: SESSION, assignmentId: ID_A, projectSlug: 'p', assignmentSlug: 'a', stage: 'review', startedAt: '2026-03-26T09:00:00Z' });

    await implementStartedCommand('b', { project: 'p', dir: resolve(home, 'projects'), cwd: home });

    const fb = await fmOf(pathB);
    expect(fb.implementationStarted).toBe(true);
    expect(fb.reworkRequested).toBe(false); // prevStage was A's review — must not key onto B
  });

  it('DOES mark rework when re-implementing the SAME assignment after reviewing it', async () => {
    const pathB = await writeAssignment('b', ID_B, { implementationStarted: 'true', reviewRequested: 'true', phase: 'review' });
    openEngagement({ sessionId: SESSION, assignmentId: ID_B, projectSlug: 'p', assignmentSlug: 'b', stage: 'review', startedAt: '2026-03-26T09:00:00Z' });

    await implementStartedCommand('b', { project: 'p', dir: resolve(home, 'projects'), cwd: home });

    expect((await fmOf(pathB)).reworkRequested).toBe(true);
  });

  it('request-review switches the engagement to review and asserts reviewRequested', async () => {
    const pathB = await writeAssignment('b', ID_B, { implementationStarted: 'true' });
    openEngagement({ sessionId: SESSION, assignmentId: ID_B, projectSlug: 'p', assignmentSlug: 'b', stage: 'implement', startedAt: '2026-03-26T09:00:00Z' });

    await requestReviewCommand('b', { project: 'p', dir: resolve(home, 'projects'), cwd: home });

    expect((await fmOf(pathB)).reviewRequested).toBe(true);
    expect(getOpenEngagement(SESSION)?.stage).toBe('review');
  });

  it('refuses a terminal assignment WITHOUT switching the engagement', async () => {
    await writeAssignment('b', ID_B, { status: 'completed' });
    openEngagement({ sessionId: SESSION, assignmentId: ID_B, projectSlug: 'p', assignmentSlug: 'b', stage: 'plan', startedAt: '2026-03-26T09:00:00Z' });

    await expect(
      implementStartedCommand('b', { project: 'p', dir: resolve(home, 'projects'), cwd: home }),
    ).rejects.toThrow(/terminal/i);
    // the engagement must NOT have been switched to implement
    expect(getOpenEngagement(SESSION)?.stage).toBe('plan');
  });
});
