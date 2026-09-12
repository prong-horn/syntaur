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
  it('prefills the decision title and body from the reply', () => {
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
    expect(html).toContain('value="Sky colour"');
    expect(html).toContain('Blue.');
  });

  it('renders comment radios without a title input', () => {
    const html = renderToStaticMarkup(
      <FileRecordForm
        kind="comment"
        item={reply}
        sourceLabel="@claude's reply"
        submitting={false}
        onSubmit={async () => {}}
        onCancel={() => {}}
      />,
    );
    expect(html).toContain('name="file-comment-type"');
    expect(html).toContain('value="note"');
    expect(html).toContain('checked=""');
    expect(html.match(/name="file-comment-type"/g)?.length).toBe(3);
    expect(html).not.toContain('Title');
  });
});
