import { describe, it, expect } from 'vitest';
import { parseClaudeLine, renderClaudeEvent, activityFromEvent } from '../claude.js';

describe('parseClaudeLine', () => {
  it('drops sidechain lines regardless of type', () => {
    const line = JSON.stringify({
      isSidechain: true,
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'should never appear' }] },
    });
    expect(parseClaudeLine(line)).toEqual({ kind: 'drop' });
  });

  it('drops recognized structural/meta types', () => {
    for (const type of ['system', 'attachment', 'mode', 'permission-mode', 'file-history-snapshot', 'bridge-session', 'queue-operation', 'last-prompt', 'ai-title', 'summary']) {
      expect(parseClaudeLine(JSON.stringify({ type }))).toEqual({ kind: 'drop' });
    }
  });

  it('treats malformed JSON as unparseable', () => {
    expect(parseClaudeLine('{not json')).toEqual({ kind: 'unparseable' });
  });

  it('treats an unrecognized top-level type as unparseable', () => {
    expect(parseClaudeLine(JSON.stringify({ type: 'codex-delta', delta: 'x' }))).toEqual({ kind: 'unparseable' });
  });

  it('treats valid JSON with no type field as unparseable', () => {
    expect(parseClaudeLine(JSON.stringify({ foo: 'bar' }))).toEqual({ kind: 'unparseable' });
  });

  it('parses a plain-string user prompt into a user-text event', () => {
    const line = JSON.stringify({ type: 'user', message: { content: 'hello there' } });
    const result = parseClaudeLine(line);
    expect(result).toEqual({ kind: 'events', events: [{ kind: 'user-text', lines: ['hello there'] }] });
  });

  it('parses assistant text + tool_use blocks, dropping thinking', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'thinking', thinking: 'secret', signature: 'sig' },
          { type: 'text', text: 'Looking at the file.' },
          { type: 'tool_use', name: 'Bash', input: { command: 'ls -la' } },
        ],
      },
    });
    const result = parseClaudeLine(line);
    expect(result).toEqual({
      kind: 'events',
      events: [
        { kind: 'assistant-text', text: 'Looking at the file.' },
        { kind: 'tool-use', name: 'Bash', summary: 'ls -la' },
      ],
    });
  });

  it('parses a tool_result block, flagging errors', () => {
    const ok = JSON.stringify({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'line1\nline2' }] },
    });
    expect(parseClaudeLine(ok)).toEqual({
      kind: 'events',
      events: [{ kind: 'tool-result', text: 'line1\nline2', isError: false }],
    });

    const errored = JSON.stringify({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'boom', is_error: true }] },
    });
    expect(parseClaudeLine(errored)).toEqual({
      kind: 'events',
      events: [{ kind: 'tool-result', text: 'boom', isError: true }],
    });
  });

  it('extracts text from array-form tool_result content blocks', () => {
    const line = JSON.stringify({
      type: 'user',
      message: {
        content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'array result' }] }],
      },
    });
    expect(parseClaudeLine(line)).toEqual({
      kind: 'events',
      events: [{ kind: 'tool-result', text: 'array result', isError: false }],
    });
  });
});

describe('renderClaudeEvent', () => {
  it('renders user-text with a ❯ prefix, capped at 3 lines', () => {
    const rows = renderClaudeEvent({ kind: 'user-text', lines: ['a', 'b', 'c', 'd', 'e'] }, 80);
    expect(rows).toEqual([
      { text: '❯ a', style: 'user' },
      { text: '  b', style: 'user' },
      { text: '  c', style: 'user' },
      { text: '  … (+2 more lines)', style: 'meta' },
    ]);
  });

  it('renders tool-use as a one-liner with the ⏺ glyph', () => {
    expect(renderClaudeEvent({ kind: 'tool-use', name: 'Edit', summary: 'DetailPane.tsx' }, 80)).toEqual([
      { text: '⏺ Edit: DetailPane.tsx', style: 'tool' },
    ]);
  });

  it('renders tool-result collapsed with a (+N lines) marker', () => {
    expect(renderClaudeEvent({ kind: 'tool-result', text: 'first\nsecond\nthird', isError: false }, 80)).toEqual([
      { text: 'first', style: 'meta' },
      { text: '  (+2 lines)', style: 'meta' },
    ]);
  });

  it('renders a failing tool-result with the error style', () => {
    expect(renderClaudeEvent({ kind: 'tool-result', text: 'boom', isError: true }, 80)).toEqual([
      { text: 'boom', style: 'error' },
    ]);
  });

  it('wraps assistant text at the given width', () => {
    const rows = renderClaudeEvent({ kind: 'assistant-text', text: 'one two three four five' }, 10);
    for (const row of rows) {
      expect(row.style).toBe('assistant');
      expect(row.text.length).toBeLessThanOrEqual(10);
    }
    expect(rows.map((r) => r.text).join(' ').replace(/\s+/g, ' ')).toContain('one two');
  });
});

describe('activityFromEvent', () => {
  it('surfaces a tool-use summary as the activity phrase', () => {
    expect(activityFromEvent({ kind: 'tool-use', name: 'Bash', summary: 'npm test' })).toBe('Bash: npm test');
  });

  it('falls back to "running <name>" with no summary', () => {
    expect(activityFromEvent({ kind: 'tool-use', name: 'Bash', summary: '' })).toBe('running Bash');
  });

  it('reports "responding…" for assistant text', () => {
    expect(activityFromEvent({ kind: 'assistant-text', text: 'hi' })).toBe('responding…');
  });

  it('returns null for user-text and tool-result', () => {
    expect(activityFromEvent({ kind: 'user-text', lines: ['hi'] })).toBeNull();
    expect(activityFromEvent({ kind: 'tool-result', text: 'x', isError: false })).toBeNull();
  });
});
