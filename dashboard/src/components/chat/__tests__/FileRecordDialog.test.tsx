import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { FileRecordForm } from '../FileRecordDialog';
import type { AgentMessageItem } from '../../../lib/chat-types';

const reply: AgentMessageItem = {
  itemId: 'reply-1',
  ticketId: 'assign-1',
  turnId: 'turn-1',
  agentId: 'claude',
  type: 'agent.message',
  messageId: 'm1',
  text: '## Sky colour\nBlue.',
  ts: '2026-09-07T12:00:00Z',
  seqFirst: 2,
  seqLast: 2,
  sealed: true,
};

describe('FileRecordForm', () => {
  it('prefills the body from the reply', () => {
    const html = renderToStaticMarkup(
      <FileRecordForm
        kind="decision"
        item={reply}
        sourceLabel="@claude's reply"
        submitting={false}
        onSubmit={async () => {}}
        onCancel={() => {}}
      />,
    );
    expect(html).toContain('File as decision');
    expect(html).toContain('## Sky colour');
    expect(html).toContain('Blue.');
  });

  it('renders a textarea for note filing without extra type controls', () => {
    const html = renderToStaticMarkup(
      <FileRecordForm
        kind="note"
        item={reply}
        sourceLabel="@claude's reply"
        submitting={false}
        onSubmit={async () => {}}
        onCancel={() => {}}
      />,
    );
    expect(html).toContain('File as note');
    expect(html).toContain('<textarea');
    expect(html).not.toContain('file-comment-type');
  });
});
