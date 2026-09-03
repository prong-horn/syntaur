import { describe, it, expect } from 'vitest';
import { parseClaudeLine } from '../sessions/claude-transcript-line.js';

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
