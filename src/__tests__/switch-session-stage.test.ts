import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import {
  initSessionDb,
  closeSessionDb,
  resetSessionDb,
} from '../dashboard/session-db.js';
import { openEngagement, getOpenEngagement } from '../db/engagement-db.js';
import { setCumulativeTokenSource, type TokenSnapshot } from '../db/engagement-tokens.js';
import { switchSessionStage } from '../utils/engagement-binding.js';

let dir: string;
const SNAP: TokenSnapshot = { models: {}, collectorRunAt: null, capturedAt: '2026-03-26T10:00:00Z' };

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'syntaur-sss-'));
  resetSessionDb();
  initSessionDb(resolve(dir, 'test.db'));
  setCumulativeTokenSource(async () => SNAP);
});
afterEach(async () => {
  setCumulativeTokenSource(null);
  closeSessionDb();
  await rm(dir, { recursive: true, force: true });
});

describe('switchSessionStage', () => {
  it('switches the open engagement to the new stage and reports the previous one', async () => {
    openEngagement({ sessionId: 's1', assignmentId: 'a1', stage: 'plan', startedAt: '2026-03-26T09:00:00Z' });
    const res = await switchSessionStage({
      sessionId: 's1',
      assignmentId: 'a1',
      projectSlug: 'p',
      assignmentSlug: 'asg',
      stage: 'implement',
    });
    expect(res.switched).toBe(true);
    expect(res.previous?.stage).toBe('plan');
    expect(res.current.stage).toBe('implement');
    expect(getOpenEngagement('s1')?.stage).toBe('implement');
  });

  it('skips the switch when already on the same (assignment, stage)', async () => {
    openEngagement({ sessionId: 's1', assignmentId: 'a1', stage: 'implement', startedAt: '2026-03-26T09:00:00Z' });
    const res = await switchSessionStage({
      sessionId: 's1',
      assignmentId: 'a1',
      projectSlug: 'p',
      assignmentSlug: 'asg',
      stage: 'implement',
    });
    expect(res.switched).toBe(false);
    // still exactly one engagement (no split)
    const n = (
      initSessionDb()
        .prepare('SELECT COUNT(*) AS n FROM engagement WHERE session_id = ?')
        .get('s1') as { n: number }
    ).n;
    expect(n).toBe(1);
  });

  it('opens a first engagement when the session has none', async () => {
    const res = await switchSessionStage({
      sessionId: 's2',
      assignmentId: 'a2',
      projectSlug: 'p',
      assignmentSlug: 'asg2',
      stage: 'review',
    });
    expect(res.switched).toBe(true);
    expect(res.previous).toBeNull();
    expect(getOpenEngagement('s2')?.stage).toBe('review');
  });
});
