import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { AgentMessage } from '../items';
import type { AgentMessageItem } from '../../../lib/chat-types';
import type { ItemAuthor } from '../../../lib/chat-api';

const author: ItemAuthor = { id: 'claude', name: 'Claude', color: 'violet', avatar: 'C' };

function reply(overrides: Partial<AgentMessageItem> = {}): AgentMessageItem {
  return {
    itemId: 'reply-1',
    ticketId: 'assign-1',
    turnId: 'turn-1',
    agentId: 'claude',
    type: 'agent.message',
    messageId: 'm1',
    text: 'Done.',
    ts: '2026-09-07T12:00:00Z',
    seqFirst: 2,
    seqLast: 2,
    sealed: true,
    ...overrides,
  };
}

describe('AgentMessage file menu', () => {
  it('renders the overflow trigger for a sealed reply with onFile', () => {
    const html = renderToStaticMarkup(
      <AgentMessage item={reply({ sealed: true, text: 'Done.' })} author={author} onFile={() => {}} />,
    );
    expect(html).toContain('aria-label="More actions"');
  });

  it('hides the menu for an unsealed reply', () => {
    const html = renderToStaticMarkup(
      <AgentMessage item={reply({ sealed: false, text: 'Streaming…' })} author={author} onFile={() => {}} />,
    );
    expect(html).not.toContain('aria-label="More actions"');
  });
});
