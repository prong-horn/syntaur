import { describe, it, expect } from 'vitest';
import { ChatNormalizer } from '../chat/normalizer.js';
import {
  backfillPlanApprovalSourceKey,
  backfillStatusSourceKey,
} from '../commands/migrate-events.js';
import { chatSessionKey, ticketScopeKey } from '../chat/broker.js';
import { inboxRowKey, compactInboxTimestamp, type InboxItem } from '../inbox/index.js';
import type { ChatEvent } from '../chat/types.js';

function assertNoColon(label: string, key: string): void {
  expect(key, label).not.toContain(':');
}

describe('colon-free key builders', () => {
  /**
   * Lockstep with `rowKey` in `dashboard/src/lib/inbox.ts` — the dashboard suite
   * (`dashboard/src/lib/__tests__/inbox.test.ts`) exercises the SPA copy; these
   * cases keep the server `inboxRowKey` aligned.
   */
  it('inboxRowKey matches dashboard rowKey expectations', () => {
    const review: InboxItem = {
      project: 'p1',
      ticketSlug: 'slug',
      ticketId: 'SYN-142',
      title: 't',
      category: 'review',
      since: '2026-09-11T05:20:00Z',
      ageMs: 0,
      summary: 's',
      action: { verb: 'Review', command: 'review' },
      ticketUpdated: '',
    };
    expect(inboxRowKey(review)).toBe('SYN-142~review');

    const question: InboxItem = {
      ...review,
      category: 'question',
      commentId: 'c1',
      since: '2026-06-16T00:00:00Z',
    };
    expect(inboxRowKey(question)).toBe('SYN-142~20260616T000000Z');

    const chatRow: InboxItem = {
      ...question,
      chat: { kind: 'reply', itemId: 'item~1', agentId: 'claude' },
    };
    expect(inboxRowKey(chatRow)).toBe('item~1');
  });

  it('inboxRowKey shapes', () => {
    const review: InboxItem = {
      project: 'p1',
      ticketSlug: 'slug',
      ticketId: 'SYN-142',
      title: 't',
      category: 'review',
      since: '2026-09-11T05:20:00Z',
      ageMs: 0,
      summary: 's',
      action: { verb: 'Review', command: 'review' },
      ticketUpdated: '',
    };
    assertNoColon('review row', inboxRowKey(review));
    expect(inboxRowKey(review)).toBe('SYN-142~review');

    const plan: InboxItem = { ...review, category: 'plan-approval' };
    assertNoColon('plan row', inboxRowKey(plan));
    expect(inboxRowKey(plan)).toBe('SYN-142~plan-approval');

    const question: InboxItem = {
      ...review,
      category: 'question',
      commentId: 'comment-1',
      since: '2026-06-15T00:00:00Z',
    };
    assertNoColon('log question row', inboxRowKey(question));
    expect(inboxRowKey(question)).toBe('SYN-142~20260615T000000Z');

    const chatRow: InboxItem = {
      ...question,
      chat: { kind: 'reply', itemId: 'turn-uuid~1', agentId: 'claude' },
    };
    assertNoColon('chat row', inboxRowKey(chatRow));
    expect(inboxRowKey(chatRow)).toBe('turn-uuid~1');
  });

  it('compactInboxTimestamp', () => {
    expect(compactInboxTimestamp('2026-09-11T05:20:00Z')).toBe('20260911T052000Z');
    assertNoColon('compact ts', compactInboxTimestamp('2026-09-11T05:20:00Z'));
  });

  it('chat session and ticket scope keys', () => {
    assertNoColon('session key', chatSessionKey('SYN-142', 'claude'));
    expect(chatSessionKey('SYN-142', 'claude')).toBe('SYN-142~claude');
    assertNoColon('ticket scope', ticketScopeKey('SYN-142'));
    expect(ticketScopeKey('SYN-142')).toBe('SYN-142~@ticket');
  });

  it('normalizer item ids', () => {
    const sessionKey = chatSessionKey('SYN-142', 'claude');
    const normalizer = new ChatNormalizer({
      ticketId: 'SYN-142',
      agentId: 'claude',
      sessionKey,
    });
    const patches = normalizer.ingest({
      seq: 1,
      ts: '2026-09-01T00:00:00Z',
      ticketId: 'SYN-142',
      agentId: 'claude',
      sessionKey,
      turnId: null,
      kind: 'system',
      payload: { level: 'info', text: 'hello' },
    });
    const itemId = patches[0]?.op === 'upsert' ? patches[0].item.itemId : '';
    assertNoColon('session-scoped item', itemId);
    expect(itemId).toBe('session~SYN-142~claude~0');

    const turnId = 'd73e60eb-9891-4ad9-a817-92eeb1df40d1';
    normalizer.ingest({
      seq: 2,
      ts: '2026-09-01T00:00:01Z',
      ticketId: 'SYN-142',
      agentId: 'claude',
      sessionKey,
      turnId,
      kind: 'turn.start',
      payload: { startedAt: '2026-09-01T00:00:01Z' },
    });
    const turnPatches = normalizer.ingest({
      seq: 3,
      ts: '2026-09-01T00:00:02Z',
      ticketId: 'SYN-142',
      agentId: 'claude',
      sessionKey,
      turnId,
      kind: 'system',
      payload: { level: 'info', text: 'in turn' },
    } as ChatEvent);
    const turnItemId = turnPatches[0]?.op === 'upsert' ? turnPatches[0].item.itemId : '';
    assertNoColon('turn-scoped item', turnItemId);
    expect(turnItemId).toMatch(/^d73e60eb-9891-4ad9-a817-92eeb1df40d1~\d+$/);

    normalizer.ingest({
      seq: 4,
      ts: '2026-09-01T00:00:03Z',
      ticketId: 'SYN-142',
      agentId: 'claude',
      sessionKey,
      turnId: null,
      kind: 'session.load',
      payload: {},
    });
    const replayPatches = normalizer.ingest({
      seq: 5,
      ts: '2026-09-01T00:00:04Z',
      ticketId: 'SYN-142',
      agentId: 'claude',
      sessionKey,
      turnId: null,
      kind: 'system',
      payload: { level: 'info', text: 'replay row' },
    });
    const replayItemId = replayPatches[0]?.op === 'upsert' ? replayPatches[0].item.itemId : '';
    assertNoColon('replay-scoped item', replayItemId);
    expect(replayItemId).toBe('replay~1~1');
  });

  it('migrate-events backfill source keys', () => {
    assertNoColon('status backfill', backfillStatusSourceKey('SYN-142', 0));
    expect(backfillStatusSourceKey('SYN-142', 0)).toBe('backfill~SYN-142~status~0');
    assertNoColon('plan backfill', backfillPlanApprovalSourceKey('SYN-142'));
    expect(backfillPlanApprovalSourceKey('SYN-142')).toBe('backfill~SYN-142~plan-approval');
  });
});
