import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { InboxRow } from '../InboxRow';
import type { InboxItem } from '../../../lib/inbox';

function makeItem(overrides: Partial<InboxItem> & Pick<InboxItem, 'category'>): InboxItem {
  return {
    project: 'demo',
    ticketSlug: 'task',
    ticketId: 'uuid-1',
    title: 'Task',
    since: '2026-06-16T00:00:00Z',
    ageMs: 60_000,
    summary: 'summary',
    action: { verb: 'Open chat', command: 'http://localhost/chat' },
    ticketUpdated: '',
    ...overrides,
  };
}

const noop = () => {};

describe('InboxRow', () => {
  it('reply row has textarea and Send', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <InboxRow
          item={makeItem({
            category: 'question',
            body: 'Which name?',
            chat: { kind: 'reply', itemId: 'i1', agentId: 'claude' },
          })}
          agents={[]}
          onMutated={noop}
          onError={noop}
          onSuccess={noop}
        />
      </MemoryRouter>,
    );
    expect(html).toContain('<textarea');
    expect(html).toContain('Reply to @claude');
    expect(html).toContain('Send');
  });

  it('permission row has option buttons and Allow all this session', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <InboxRow
          item={makeItem({
            category: 'question',
            chat: { kind: 'permission', itemId: 'p1', agentId: 'cursor' },
            card: {
              requestId: 'req-1',
              kind: 'permission',
              settled: false,
              options: [
                { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
                { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
              ],
            },
          })}
          agents={[]}
          onMutated={noop}
          onError={noop}
          onSuccess={noop}
        />
      </MemoryRouter>,
    );
    expect(html).toContain('Allow once');
    expect(html).toContain('Deny');
    expect(html).toContain('Allow all this session');
  });

  it('settled permission row has no action buttons', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <InboxRow
          item={makeItem({
            category: 'question',
            chat: { kind: 'permission', itemId: 'p1', agentId: 'cursor' },
            card: {
              requestId: 'req-1',
              kind: 'permission',
              settled: true,
              options: [{ optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' }],
            },
          })}
          agents={[]}
          onMutated={noop}
          onError={noop}
          onSuccess={noop}
        />
      </MemoryRouter>,
    );
    expect(html).toContain('Answered — clearing');
    expect(html).not.toContain('Allow all this session');
  });

  it('ask row has choice buttons', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <InboxRow
          item={makeItem({
            category: 'question',
            chat: { kind: 'ask', itemId: 'a1', agentId: 'cursor' },
            card: {
              requestId: 'req-ask',
              kind: 'ask',
              settled: false,
              options: [{ id: 'alpha', label: 'Alpha' }, { id: 'beta', label: 'Beta' }],
            },
          })}
          agents={[]}
          onMutated={noop}
          onError={noop}
          onSuccess={noop}
        />
      </MemoryRouter>,
    );
    expect(html).toContain('Alpha');
    expect(html).toContain('Beta');
  });

  it('settled ask row has no action buttons', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <InboxRow
          item={makeItem({
            category: 'question',
            chat: { kind: 'ask', itemId: 'a1', agentId: 'cursor' },
            card: {
              requestId: 'req-ask',
              kind: 'ask',
              settled: true,
              options: [{ id: 'alpha', label: 'Alpha' }, { id: 'beta', label: 'Beta' }],
            },
          })}
          agents={[]}
          onMutated={noop}
          onError={noop}
          onSuccess={noop}
        />
      </MemoryRouter>,
    );
    expect(html).toContain('Answered — clearing');
    expect(html).not.toContain('Alpha');
    expect(html).not.toContain('Beta');
  });

  it('review row has Accept and Reopen', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <InboxRow
          item={makeItem({
            category: 'review',
            acceptCommand: 'complete',
            reopenCommand: 'start',
          })}
          agents={[]}
          onMutated={noop}
          onError={noop}
          onSuccess={noop}
        />
      </MemoryRouter>,
    );
    expect(html).toContain('Accept');
    expect(html).toContain('Reopen');
  });

  it('plan row has Approve', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <InboxRow
          item={makeItem({ category: 'plan-approval' })}
          agents={[]}
          onMutated={noop}
          onError={noop}
          onSuccess={noop}
        />
      </MemoryRouter>,
    );
    expect(html).toContain('Approve');
    expect(html).toContain('Read plan');
  });

  it('chat row renders id with literal colon in item id', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <InboxRow
          item={makeItem({
            category: 'question',
            chat: { kind: 'reply', itemId: 'abc:def', agentId: 'claude' },
          })}
          agents={[]}
          onMutated={noop}
          onError={noop}
          onSuccess={noop}
        />
      </MemoryRouter>,
    );
    expect(html).toContain('id="abc:def"');
  });

  it('plain row renders id from commentId', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <InboxRow
          item={makeItem({ category: 'question', commentId: 'comment-42' })}
          agents={[]}
          onMutated={noop}
          onError={noop}
          onSuccess={noop}
        />
      </MemoryRouter>,
    );
    expect(html).toContain('id="comment-42"');
  });

  it('highlighted adds the ring class', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <InboxRow
          item={makeItem({ category: 'question', commentId: 'c1' })}
          agents={[]}
          highlighted
          onMutated={noop}
          onError={noop}
          onSuccess={noop}
        />
      </MemoryRouter>,
    );
    expect(html).toContain('ring-2 ring-primary');
  });

  it('plain question keeps reply box', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <InboxRow
          item={makeItem({ category: 'question', commentId: 'c1' })}
          agents={[]}
          onMutated={noop}
          onError={noop}
          onSuccess={noop}
        />
      </MemoryRouter>,
    );
    expect(html).toContain('Reply inline');
    expect(html).toContain('Resolve');
  });

  it('snoozable review row contains Not now and the three choices', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <InboxRow
          item={makeItem({ category: 'review', acceptCommand: 'complete', reopenCommand: 'start' })}
          agents={[]}
          onMutated={noop}
          onError={noop}
          onSuccess={noop}
        />
      </MemoryRouter>,
    );
    expect(html).toContain('Not now');
    expect(html).toContain('One day');
    expect(html).toContain('One week');
    expect(html).toContain('Until it changes');
  });

  it('unsettled permission row does not contain Not now', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <InboxRow
          item={makeItem({
            category: 'question',
            chat: { kind: 'permission', itemId: 'perm-1', agentId: 'cursor' },
            card: {
              requestId: 'req-1',
              kind: 'permission',
              options: [{ optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' }],
              settled: false,
            },
          })}
          agents={[]}
          onMutated={noop}
          onError={noop}
          onSuccess={noop}
        />
      </MemoryRouter>,
    );
    expect(html).not.toContain('Not now');
  });

  it('snoozed row renders until label and Unsnooze without Not now', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <InboxRow
          item={makeItem({
            category: 'review',
            acceptCommand: 'complete',
            reopenCommand: 'start',
            snoozed: { until: '2026-06-20T00:00:00Z' },
          })}
          agents={[]}
          snoozed
          onMutated={noop}
          onError={noop}
          onSuccess={noop}
        />
      </MemoryRouter>,
    );
    expect(html).toContain('Unsnooze');
    expect(html).not.toContain('Not now');
    expect(html).toContain('opacity-60');
  });
});
