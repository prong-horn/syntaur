import { describe, it, expect } from 'vitest';
import { renderComments, formatCommentEntry, type Comment } from '../templates/index.js';
import { parseComments } from '../dashboard/parser.js';

describe('renderComments', () => {
  it('produces valid frontmatter with zero entries', () => {
    const out = renderComments({
      assignment: 'do-thing',
      timestamp: '2026-04-20T12:00:00Z',
    });
    expect(out).toContain('assignment: do-thing');
    expect(out).toContain('entryCount: 0');
    expect(out).toContain('# Comments');
    expect(out).toContain('No comments yet.');
  });
});

describe('formatCommentEntry', () => {
  it('formats a note without reply-to or resolved fields', () => {
    const comment: Comment = {
      id: 'c-1',
      timestamp: '2026-04-20T13:00:00Z',
      author: 'alice',
      type: 'note',
      body: 'Looks good.',
    };
    const entry = formatCommentEntry(comment);
    expect(entry).toContain('## c-1');
    expect(entry).toContain('**Recorded:** 2026-04-20T13:00:00Z');
    expect(entry).toContain('**Author:** alice');
    expect(entry).toContain('**Type:** note');
    expect(entry).not.toContain('**Reply to:**');
    expect(entry).not.toContain('**Resolved:**');
    expect(entry).toContain('Looks good.');
  });

  it('formats a question with a resolved flag', () => {
    const comment: Comment = {
      id: 'c-2',
      timestamp: '2026-04-20T13:30:00Z',
      author: 'bob',
      type: 'question',
      body: 'What about edge case X?',
      resolved: false,
    };
    const entry = formatCommentEntry(comment);
    expect(entry).toContain('**Type:** question');
    expect(entry).toContain('**Resolved:** false');
  });

  it('formats a reply comment with a reply-to pointer', () => {
    const comment: Comment = {
      id: 'c-3',
      timestamp: '2026-04-20T14:00:00Z',
      author: 'claude-1',
      type: 'note',
      body: 'Replying to c-2.',
      replyTo: 'c-2',
    };
    const entry = formatCommentEntry(comment);
    expect(entry).toContain('**Reply to:** c-2');
  });
});

describe('parseComments round-trip', () => {
  it('empty template parses to zero entries', () => {
    const template = renderComments({
      assignment: 'ex',
      timestamp: '2026-04-20T10:00:00Z',
    });
    const parsed = parseComments(template);
    expect(parsed.assignment).toBe('ex');
    expect(parsed.entryCount).toBe(0);
    expect(parsed.entries).toHaveLength(0);
  });

  it('round-trips a file with a question, a reply note, and a resolved question', () => {
    const file = [
      '---',
      'assignment: example',
      'entryCount: 3',
      'generated: "2026-04-20T10:00:00Z"',
      'updated: "2026-04-20T14:00:00Z"',
      '---',
      '',
      '# Comments',
      '',
      '## c-1',
      '',
      '**Recorded:** 2026-04-20T10:00:00Z',
      '**Author:** claude-1',
      '**Type:** question',
      '**Resolved:** false',
      '',
      'Open question body.',
      '',
      '## c-2',
      '',
      '**Recorded:** 2026-04-20T12:00:00Z',
      '**Author:** human',
      '**Type:** note',
      '**Reply to:** c-1',
      '',
      'Reply note body.',
      '',
      '## c-3',
      '',
      '**Recorded:** 2026-04-20T14:00:00Z',
      '**Author:** human',
      '**Type:** question',
      '**Resolved:** true',
      '',
      'Resolved question body.',
      '',
    ].join('\n');

    const parsed = parseComments(file);
    expect(parsed.assignment).toBe('example');
    expect(parsed.entryCount).toBe(3);
    expect(parsed.entries).toHaveLength(3);

    expect(parsed.entries[0].id).toBe('c-1');
    expect(parsed.entries[0].type).toBe('question');
    expect(parsed.entries[0].resolved).toBe(false);
    expect(parsed.entries[0].replyTo).toBeUndefined();

    expect(parsed.entries[1].id).toBe('c-2');
    expect(parsed.entries[1].type).toBe('note');
    expect(parsed.entries[1].replyTo).toBe('c-1');

    expect(parsed.entries[2].id).toBe('c-3');
    expect(parsed.entries[2].type).toBe('question');
    expect(parsed.entries[2].resolved).toBe(true);
  });
});
