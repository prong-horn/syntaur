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
import {
  setCumulativeTokenSource,
  type TokenSnapshot,
} from '../db/engagement-tokens.js';
import { switchSessionStage } from '../utils/engagement-binding.js';

const FAKE: TokenSnapshot = {
  models: {},
  collectorRunAt: null,
  capturedAt: '2026-06-01T00:00:00.000Z',
};

let testDir: string;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'syntaur-binding-'));
  resetSessionDb();
  initSessionDb(resolve(testDir, 'test.db'));
  setCumulativeTokenSource(async () => FAKE);
});

afterEach(async () => {
  setCumulativeTokenSource(null);
  closeSessionDb();
  await rm(testDir, { recursive: true, force: true });
});

describe('switchSessionStage same-target skip (ticket_id only)', () => {
  it('does NOT split when the open engagement already has the same ticket_id and stage', async () => {
    openEngagement({
      sessionId: 's1',
      ticketId: 'RES-1',
      stage: 'implement',
      startedAt: '2026-06-01T01:00:00.000Z',
    });
    const before = getOpenEngagement('s1')!;

    const result = await switchSessionStage({
      sessionId: 's1',
      ticketId: 'RES-1',
      projectSlug: 'proj',
      ticketSlug: 'a',
      stage: 'implement',
    });

    expect(result.switched).toBe(false);
    const after = getOpenEngagement('s1')!;
    expect(after.id).toBe(before.id); // same interval — not split
  });

  it('DOES switch when the target ticket_id differs', async () => {
    openEngagement({
      sessionId: 's2',
      ticketId: 'IDA-1',
      stage: 'implement',
      startedAt: '2026-06-01T01:00:00.000Z',
    });
    const before = getOpenEngagement('s2')!;

    const result = await switchSessionStage({
      sessionId: 's2',
      ticketId: 'IDB-1',
      projectSlug: 'proj',
      ticketSlug: 'b',
      stage: 'implement',
    });

    expect(result.switched).toBe(true);
    const after = getOpenEngagement('s2')!;
    expect(after.id).not.toBe(before.id);
    expect(after.ticket_id).toBe('IDB-1');
  });

  it('DOES switch when both ids are present and differ', async () => {
    openEngagement({
      sessionId: 's3',
      ticketId: 'IDA-1',
      stage: 'implement',
      startedAt: '2026-06-01T01:00:00.000Z',
    });

    const result = await switchSessionStage({
      sessionId: 's3',
      ticketId: 'IDB-1',
      projectSlug: 'proj',
      ticketSlug: 'a',
      stage: 'implement',
    });

    expect(result.switched).toBe(true);
  });

  it('skips when both ids are present and equal (no churn on repeat)', async () => {
    openEngagement({
      sessionId: 's4',
      ticketId: 'IDA-1',
      stage: 'implement',
      startedAt: '2026-06-01T01:00:00.000Z',
    });

    const result = await switchSessionStage({
      sessionId: 's4',
      ticketId: 'IDA-1',
      projectSlug: 'proj',
      ticketSlug: 'a',
      stage: 'implement',
    });

    expect(result.switched).toBe(false);
  });

  it('DOES switch when the stage differs (real stage transition)', async () => {
    openEngagement({
      sessionId: 's5',
      ticketId: 'IDA-1',
      stage: 'implement',
      startedAt: '2026-06-01T01:00:00.000Z',
    });

    const result = await switchSessionStage({
      sessionId: 's5',
      ticketId: 'IDA-1',
      projectSlug: 'proj',
      ticketSlug: 'a',
      stage: 'review', // stage change
    });

    expect(result.switched).toBe(true);
    expect(getOpenEngagement('s5')!.stage).toBe('review');
  });
});
