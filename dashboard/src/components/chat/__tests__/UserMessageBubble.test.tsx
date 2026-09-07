import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { UserMessageBubble } from '../items';
import type { UserMessageItem } from '../../../lib/chat-types';
import type { ItemAuthor } from '../../../lib/chat-api';

const author: ItemAuthor = { id: 'human', name: 'You', color: 'slate', avatar: 'Y' };

function message(overrides: Partial<UserMessageItem> = {}): UserMessageItem {
  return {
    itemId: 'i1',
    assignmentId: 'assign-1',
    turnId: null,
    agentId: 'human',
    type: 'user.message',
    messageId: 'm1',
    text: 'hello',
    state: 'sent',
    ts: '2026-09-06T12:00:00.000Z',
    seqFirst: 1,
    seqLast: 1,
    sealed: true,
    targets: ['claude'],
    deliveredTo: ['claude'],
    ...overrides,
  };
}

describe('UserMessageBubble attachments', () => {
  it('renders thumbnails for attachments', () => {
    const html = renderToStaticMarkup(
      <UserMessageBubble
        item={message({
          attachments: [
            { id: 'a1', mimeType: 'image/png', bytes: 68, name: 'one.png' },
            { id: 'a2', mimeType: 'image/jpeg', bytes: 120, name: 'two.jpg' },
          ],
        })}
        author={author}
        onWithdraw={() => {}}
      />,
    );
    expect(html.match(/<img /g)?.length).toBe(2);
    expect(html).toContain('/api/assignments/assign-1/chat/attachments/a1');
    expect(html).toContain('/api/assignments/assign-1/chat/attachments/a2');
    expect(html).toContain('target="_blank"');
  });

  it('hides the text block when the message is image-only', () => {
    const html = renderToStaticMarkup(
      <UserMessageBubble
        item={message({ text: '', attachments: [{ id: 'a1', mimeType: 'image/png', bytes: 68, name: 'solo.png' }] })}
        author={author}
        onWithdraw={() => {}}
      />,
    );
    expect(html).toContain('<img ');
    expect(html).not.toContain('whitespace-pre-wrap');
  });
});

describe('UserMessageBubble file menu', () => {
  it('renders the overflow trigger for a sent message with onFile', () => {
    const html = renderToStaticMarkup(
      <UserMessageBubble
        item={message({ state: 'sent', text: 'hello' })}
        author={author}
        onWithdraw={() => {}}
        onFile={() => {}}
      />,
    );
    expect(html).toContain('aria-label="More actions"');
  });

  it('hides the menu for withdrawn and replayed messages', () => {
    const withdrawn = renderToStaticMarkup(
      <UserMessageBubble
        item={message({ state: 'withdrawn' })}
        author={author}
        onWithdraw={() => {}}
        onFile={() => {}}
      />,
    );
    expect(withdrawn).not.toContain('aria-label="More actions"');

    const replayed = renderToStaticMarkup(
      <UserMessageBubble
        item={message({ state: 'replayed' })}
        author={author}
        onWithdraw={() => {}}
        onFile={() => {}}
      />,
    );
    expect(replayed).not.toContain('aria-label="More actions"');
  });
});
