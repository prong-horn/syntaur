import { describe, expect, it } from 'vitest';
import {
  assignmentHref,
  commentsEndpoint,
  formatAge,
  groupInboxItems,
  parseTransitionCommand,
  resolveCommentEndpoint,
  transitionEndpoint,
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
    ...overrides,
  };
}

describe('groupInboxItems', () => {
  it('groups by category in the stable canonical order, omitting empty groups', () => {
    const items = [
      makeItem({ category: 'plan-approval', assignmentId: 'p1' }),
      makeItem({ category: 'review', assignmentId: 'r1' }),
      makeItem({ category: 'question', assignmentId: 'q1' }),
    ];
    const groups = groupInboxItems(items);
    expect(groups.map((g) => g.category)).toEqual(['review', 'question', 'plan-approval']);
    // 'blocked' had no items → omitted.
    expect(groups.find((g) => g.category === 'blocked')).toBeUndefined();
  });

  it('orders items oldest-first (largest ageMs) within each group', () => {
    const items = [
      makeItem({ category: 'review', assignmentId: 'young', ageMs: 1000 }),
      makeItem({ category: 'review', assignmentId: 'old', ageMs: 99_000 }),
      makeItem({ category: 'review', assignmentId: 'mid', ageMs: 50_000 }),
    ];
    const [reviewGroup] = groupInboxItems(items);
    expect(reviewGroup.count).toBe(3);
    expect(reviewGroup.items.map((i) => i.assignmentId)).toEqual(['old', 'mid', 'young']);
  });

  it('returns no groups for an empty inbox', () => {
    expect(groupInboxItems([])).toEqual([]);
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

describe('parseTransitionCommand', () => {
  it('extracts the verb from a derived review command', () => {
    expect(parseTransitionCommand('syntaur complete my-task --project proj')).toBe('complete');
    expect(parseTransitionCommand('syntaur custom-accept my-task')).toBe('custom-accept');
  });

  it('returns null for an unexpected shape', () => {
    expect(parseTransitionCommand('not a command')).toBeNull();
    expect(parseTransitionCommand('')).toBeNull();
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

  it('maps blocked unblock for project and standalone', () => {
    const proj = makeItem({ category: 'blocked' });
    expect(transitionEndpoint(proj, 'unblock').url).toBe(
      '/api/projects/proj/assignments/my-task/transitions/unblock',
    );
    const standalone = makeItem({ category: 'blocked', project: null, assignmentId: 'uuid-b' });
    expect(transitionEndpoint(standalone, 'unblock').url).toBe(
      '/api/assignments/uuid-b/transitions/unblock',
    );
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
