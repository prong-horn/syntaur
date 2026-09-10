import { describe, expect, it } from 'vitest';
import {
  assignmentHref,
  chatItemHref,
  chatReplyText,
  commentsEndpoint,
  formatAge,
  inboxRowHref,
  isSnoozable,
  planApproveEndpoint,
  projectOptions,
  resolveCommentEndpoint,
  rowKey,
  rowKind,
  snoozeEndpoint,
  snoozeLabel,
  transitionEndpoint,
  unsnoozeEndpoint,
  waitingLabel,
  type InboxItem,
} from '../inbox';

/** Build an InboxItem fixture with category-appropriate defaults. */
function makeItem(overrides: Partial<InboxItem> & Pick<InboxItem, 'category'>): InboxItem {
  return {
    project: 'proj',
    assignmentSlug: 'my-task',
    assignmentId: 'uuid-1',
    title: 'My Task',
    since: '2026-06-16T00:00:00Z',
    ageMs: 1000,
    summary: 'context',
    action: { verb: 'Accept', command: 'syntaur complete my-task --project proj' },
    assignmentUpdated: '',
    ...overrides,
  };
}

describe('rowKey', () => {
  it('prefers commentId, then chat item id, then category:assignmentId', () => {
    expect(rowKey(makeItem({ category: 'question', commentId: 'c1' }))).toBe('c1');
    expect(
      rowKey(
        makeItem({
          category: 'question',
          chat: { kind: 'reply', itemId: 'item:1', agentId: 'claude' },
        }),
      ),
    ).toBe('item:1');
    expect(rowKey(makeItem({ category: 'review', assignmentId: 'uuid-r' }))).toBe(
      'review:uuid-r',
    );
  });
});

describe('inboxRowHref', () => {
  it('keeps colons literal in the hash', () => {
    const item = makeItem({
      category: 'question',
      chat: { kind: 'permission', itemId: 'abc:def', agentId: 'cursor' },
    });
    expect(inboxRowHref(item)).toBe('/inbox#abc:def');
  });
});

describe('chatReplyText', () => {
  it('trims and prefixes with @agent', () => {
    expect(chatReplyText('claude', '  hello there  ')).toBe('@claude hello there');
  });
});

describe('projectOptions', () => {
  it('sorts and dedupes project slugs with null last', () => {
    const items = [
      makeItem({ category: 'review', project: 'beta' }),
      makeItem({ category: 'question', project: 'alpha' }),
      makeItem({ category: 'review', project: 'alpha' }),
      makeItem({ category: 'plan-approval', project: null, assignmentId: 's1' }),
    ];
    expect(projectOptions(items)).toEqual(['alpha', 'beta', null]);
  });
});

describe('rowKind', () => {
  it('classifies each inbox row shape', () => {
    expect(rowKind(makeItem({ category: 'review' }))).toBe('review');
    expect(rowKind(makeItem({ category: 'plan-approval' }))).toBe('plan-approval');
    expect(rowKind(makeItem({ category: 'question' }))).toBe('plain-question');
    expect(
      rowKind(
        makeItem({
          category: 'question',
          chat: { kind: 'reply', itemId: 'i', agentId: 'claude' },
        }),
      ),
    ).toBe('reply');
    expect(
      rowKind(
        makeItem({
          category: 'question',
          chat: { kind: 'permission', itemId: 'i', agentId: 'cursor' },
        }),
      ),
    ).toBe('permission');
    expect(
      rowKind(
        makeItem({
          category: 'question',
          chat: { kind: 'ask', itemId: 'i', agentId: 'cursor' },
        }),
      ),
    ).toBe('ask');
  });
});

describe('waitingLabel', () => {
  it('labels each row kind', () => {
    expect(
      waitingLabel(
        makeItem({
          category: 'question',
          chat: { kind: 'reply', itemId: 'i', agentId: 'claude' },
        }),
        { name: 'claude' },
      ),
    ).toBe('@claude asked');
    expect(
      waitingLabel(
        makeItem({
          category: 'question',
          chat: { kind: 'permission', itemId: 'i', agentId: 'cursor' },
        }),
      ),
    ).toBe('@cursor is waiting for permission');
    expect(
      waitingLabel(
        makeItem({
          category: 'question',
          chat: { kind: 'ask', itemId: 'i', agentId: 'cursor' },
        }),
      ),
    ).toBe('@cursor is asking');
    expect(waitingLabel(makeItem({ category: 'plan-approval' }))).toBe('Plan awaiting your approval');
    expect(waitingLabel(makeItem({ category: 'review' }))).toBe('Awaiting your review');
    expect(waitingLabel(makeItem({ category: 'question' }))).toBe('Question');
  });
});

describe('planApproveEndpoint', () => {
  it('maps project and standalone approve URLs', () => {
    const proj = makeItem({ category: 'plan-approval' });
    expect(planApproveEndpoint(proj)).toEqual({
      method: 'POST',
      url: '/api/projects/proj/assignments/my-task/plan/approve',
    });
    const standalone = makeItem({ category: 'plan-approval', project: null, assignmentId: 'uuid-pa' });
    expect(planApproveEndpoint(standalone)).toEqual({
      method: 'POST',
      url: '/api/assignments/uuid-pa/plan/approve',
    });
  });
});

describe('formatAge', () => {
  it('renders just now under a minute and for negative/invalid input', () => {
    expect(formatAge(0)).toBe('just now');
    expect(formatAge(59_000)).toBe('just now');
    expect(formatAge(-5)).toBe('just now');
    expect(formatAge(Number.NaN)).toBe('just now');
  });

  it('renders minutes, hours, and days at the right boundaries', () => {
    expect(formatAge(60_000)).toBe('1m');
    expect(formatAge(59 * 60_000)).toBe('59m');
    expect(formatAge(60 * 60_000)).toBe('1h');
    expect(formatAge(23 * 60 * 60_000)).toBe('23h');
    expect(formatAge(24 * 60 * 60_000)).toBe('1d');
    expect(formatAge(3 * 24 * 60 * 60_000)).toBe('3d');
  });
});

describe('transitionEndpoint', () => {
  it('maps review accept for a project item', () => {
    const item = makeItem({ category: 'review' });
    expect(transitionEndpoint(item, 'complete')).toEqual({
      method: 'POST',
      url: '/api/projects/proj/assignments/my-task/transitions/complete',
    });
  });

  it('maps review accept for a standalone item (UUID-keyed)', () => {
    const item = makeItem({ category: 'review', project: null, assignmentId: 'uuid-99' });
    expect(transitionEndpoint(item, 'complete')).toEqual({
      method: 'POST',
      url: '/api/assignments/uuid-99/transitions/complete',
    });
  });
});

describe('commentsEndpoint', () => {
  it('maps question reply for project and standalone', () => {
    const proj = makeItem({ category: 'question' });
    expect(commentsEndpoint(proj)).toEqual({
      method: 'POST',
      url: '/api/projects/proj/assignments/my-task/comments',
    });
    const standalone = makeItem({ category: 'question', project: null, assignmentId: 'uuid-q' });
    expect(commentsEndpoint(standalone)).toEqual({
      method: 'POST',
      url: '/api/assignments/uuid-q/comments',
    });
  });
});

describe('resolveCommentEndpoint', () => {
  it('maps question resolve for project and standalone (PATCH)', () => {
    const proj = makeItem({ category: 'question' });
    expect(resolveCommentEndpoint(proj, 'c1')).toEqual({
      method: 'PATCH',
      url: '/api/projects/proj/assignments/my-task/comments/c1/resolved',
    });
    const standalone = makeItem({ category: 'question', project: null, assignmentId: 'uuid-q' });
    expect(resolveCommentEndpoint(standalone, 'c2')).toEqual({
      method: 'PATCH',
      url: '/api/assignments/uuid-q/comments/c2/resolved',
    });
  });
});

describe('assignmentHref', () => {
  it('builds the project jump-href, with and without a tab', () => {
    const item = makeItem({ category: 'plan-approval' });
    expect(assignmentHref(item)).toBe('/projects/proj/assignments/my-task');
    expect(assignmentHref(item, 'plan')).toBe('/projects/proj/assignments/my-task?tab=plan');
    expect(assignmentHref(item, 'comments')).toBe(
      '/projects/proj/assignments/my-task?tab=comments',
    );
  });

  it('builds the standalone jump-href keyed on the UUID', () => {
    const item = makeItem({ category: 'plan-approval', project: null, assignmentId: 'uuid-pa' });
    expect(assignmentHref(item)).toBe('/assignments/uuid-pa');
    expect(assignmentHref(item, 'plan')).toBe('/assignments/uuid-pa?tab=plan');
  });
});

describe('chatItemHref', () => {
  it('builds project and standalone chat item links', () => {
    const item = makeItem({
      category: 'question',
      chat: { kind: 'reply', itemId: 'item-1', agentId: 'claude' },
    });
    expect(chatItemHref(item)).toBe('/projects/proj/assignments/my-task?tab=chat#item-1');
    const standalone = makeItem({
      category: 'question',
      project: null,
      assignmentId: 'uuid-q',
      chat: { kind: 'ask', itemId: 'q-2', agentId: 'cursor' },
    });
    expect(chatItemHref(standalone)).toBe('/assignments/uuid-q?tab=chat#q-2');
  });

  it('keeps colons in scope item ids unencoded in the hash', () => {
    const item = makeItem({
      category: 'question',
      chat: { kind: 'reply', itemId: 'd73e60eb-9891-4ad9-a817-92eeb1df40d1:1', agentId: 'claude' },
    });
    expect(chatItemHref(item)).toBe(
      '/projects/proj/assignments/my-task?tab=chat#d73e60eb-9891-4ad9-a817-92eeb1df40d1:1',
    );
  });
});

describe('snooze endpoints', () => {
  it('encode colons in row keys', () => {
    const key = 'review:uuid:1';
    expect(snoozeEndpoint(key).url).toBe('/api/inbox/snoozes/review%3Auuid%3A1');
    expect(snoozeEndpoint(key).method).toBe('PUT');
    expect(unsnoozeEndpoint(key).method).toBe('DELETE');
  });
});

describe('snoozeLabel', () => {
  const now = Date.parse('2026-06-16T12:00:00Z');

  it('labels until-change, one day, and longer windows', () => {
    expect(snoozeLabel(null, now)).toBe('until it changes');
    expect(snoozeLabel('2026-06-17T12:00:00Z', now)).toBe('for 1d');
    expect(snoozeLabel('2026-06-25T12:00:00Z', now)).toMatch(/^until /);
  });
});

describe('isSnoozable', () => {
  it('allows snooze for non-live rows', () => {
    expect(isSnoozable(makeItem({ category: 'review' }))).toBe(true);
    expect(
      isSnoozable(
        makeItem({
          category: 'question',
          chat: { kind: 'permission', itemId: 'p1', agentId: 'cursor' },
          card: { requestId: 'r', kind: 'permission', options: [], settled: true },
        }),
      ),
    ).toBe(true);
  });

  it('rejects unsettled permission/ask cards', () => {
    expect(
      isSnoozable(
        makeItem({
          category: 'question',
          chat: { kind: 'permission', itemId: 'p1', agentId: 'cursor' },
          card: { requestId: 'r', kind: 'permission', options: [], settled: false },
        }),
      ),
    ).toBe(false);
    expect(
      isSnoozable(
        makeItem({
          category: 'question',
          chat: { kind: 'ask', itemId: 'a1', agentId: 'cursor' },
          card: null,
        }),
      ),
    ).toBe(false);
  });
});
