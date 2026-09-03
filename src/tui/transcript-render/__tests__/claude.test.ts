import { describe, it, expect } from 'vitest';
import { renderClaudeEvent, activityFromEvent } from '../claude.js';

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
