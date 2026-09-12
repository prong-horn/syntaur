import { describe, expect, it, vi } from 'vitest';
import {
  diffChatRows,
  notificationFor,
  notificationPermission,
  notifyFreshRows,
  type NotificationApi,
  type NotificationLike,
} from '../inbox-notify';
import type { InboxItem } from '../inbox';

function makeItem(overrides: Partial<InboxItem> & Pick<InboxItem, 'category'>): InboxItem {
  return {
    project: 'proj',
    ticketSlug: 'my-task',
    ticketId: 'uuid-1',
    title: 'My Task',
    since: '2026-06-16T00:00:00Z',
    ageMs: 1000,
    summary: 'context line',
    action: { verb: 'Answer', command: 'syntaur comment my-task' },
    ticketUpdated: '',
    ...overrides,
  };
}

const agents = [
  {
    id: 'cursor',
    name: 'Cursor',
    color: 'violet' as const,
    harness: 'cursor' as const,
    model: null,
    mode: null,
    effort: null,
    respondsTo: 'mentions' as const,
    description: null,
    avatar: 'C',
    default: true,
    source: null,
    builtin: true,
    overridesBuiltin: false,
    missing: null,
  },
];

describe('diffChatRows', () => {
  const perm = makeItem({
    category: 'question',
    commentId: 'c-perm',
    chat: { kind: 'permission', itemId: 'perm-1', agentId: 'cursor' },
  });
  const plan = makeItem({ category: 'plan-approval', ticketId: 'uuid-plan' });
  const reply = makeItem({
    category: 'question',
    commentId: 'c-reply',
    chat: { kind: 'reply', itemId: 'reply-1', agentId: 'claude' },
  });

  it('seeds seen on first paint and returns no fresh rows', () => {
    const { seen, fresh } = diffChatRows(null, [perm, plan]);
    expect(fresh).toEqual([]);
    expect(seen).toEqual(new Set(['c-perm']));
  });

  it('returns only new chat rows on subsequent calls', () => {
    const first = diffChatRows(null, [perm]);
    const second = diffChatRows(first.seen, [perm, reply, plan]);
    expect(second.fresh).toEqual([reply]);
    const third = diffChatRows(second.seen, [perm, reply, plan]);
    expect(third.fresh).toEqual([]);
  });

  it('does not re-notify a row that dropped and returned with the same key', () => {
    const first = diffChatRows(null, [perm]);
    const dropped = diffChatRows(first.seen, [plan]);
    const returned = diffChatRows(dropped.seen, [perm, plan]);
    expect(returned.fresh).toEqual([]);
  });
});

describe('notificationFor', () => {
  it('uses the agent display name when available', () => {
    const item = makeItem({
      category: 'question',
      chat: { kind: 'permission', itemId: 'p1', agentId: 'cursor' },
    });
    expect(notificationFor(item, agents).title).toBe('@Cursor is waiting for permission');
  });

  it('falls back to @agentId without a matching agent', () => {
    const item = makeItem({
      category: 'question',
      chat: { kind: 'reply', itemId: 'r1', agentId: 'claude' },
    });
    expect(notificationFor(item, []).title).toBe('@claude asked');
  });

  it('builds body, tag and href', () => {
    const item = makeItem({
      category: 'question',
      commentId: 'c-ask',
      chat: { kind: 'ask', itemId: 'ask-1', agentId: 'cursor' },
    });
    const n = notificationFor(item, agents);
    expect(n.body).toBe('My Task — context line');
    expect(n.tag).toBe('c-ask');
    expect(n.href).toBe('/inbox#c-ask');
  });
});

describe('notificationPermission', () => {
  it('returns unsupported when api is undefined', () => {
    expect(notificationPermission(undefined)).toBe('unsupported');
  });
});

describe('notifyFreshRows', () => {
  let lastInstance: FakeNotification | null = null;
  const closeMock = vi.fn();

  class FakeNotification implements NotificationLike {
    static records: Array<{ title: string; body?: string; tag?: string }> = [];
    onclick: ((ev: unknown) => void) | null = null;
    close = closeMock;
    constructor(title: string, options?: { body?: string; tag?: string }) {
      FakeNotification.records.push({ title, ...options });
      lastInstance = this;
    }
  }

  const fakeApi = Object.assign(
    function FakeApi(title: string, options?: { body?: string; tag?: string }) {
      return new FakeNotification(title, options);
    },
    {
      permission: 'granted' as const,
      requestPermission: async () => 'granted' as const,
    },
  ) as unknown as NotificationApi;

  it('creates one notification per fresh row when granted and onclick opens the row', () => {
    FakeNotification.records = [];
    lastInstance = null;
    closeMock.mockClear();
    const item = makeItem({
      category: 'question',
      commentId: 'c-new',
      chat: { kind: 'permission', itemId: 'p-new', agentId: 'cursor' },
    });
    const opened: string[] = [];
    const count = notifyFreshRows({
      fresh: [item],
      agents,
      api: fakeApi,
      onOpen: (href) => opened.push(href),
    });
    expect(count).toBe(1);
    expect(FakeNotification.records).toHaveLength(1);
    expect(lastInstance).not.toBeNull();
    lastInstance!.onclick?.(null);
    expect(opened).toEqual(['/inbox#c-new']);
    expect(closeMock).toHaveBeenCalledOnce();
  });

  it('returns 0 when permission is not granted', () => {
    const deniedApi = Object.assign(
      function DeniedApi(title: string, options?: { body?: string; tag?: string }) {
        return new FakeNotification(title, options);
      },
      { permission: 'denied' as const, requestPermission: async () => 'denied' as const },
    ) as unknown as NotificationApi;
    const count = notifyFreshRows({
      fresh: [
        makeItem({
          category: 'question',
          chat: { kind: 'reply', itemId: 'r', agentId: 'claude' },
        }),
      ],
      agents: [],
      api: deniedApi,
      onOpen: () => {},
    });
    expect(count).toBe(0);
  });
});
