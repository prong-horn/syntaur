import { describe, it, expect } from 'vitest';
import { renderProgress, formatProgressEntry } from '../templates/index.js';

describe('renderProgress', () => {
  it('produces valid frontmatter without per-file counters', () => {
    const out = renderProgress({
      ticket: 'do-thing',
      timestamp: '2026-04-20T12:00:00Z',
    });
    expect(out).toContain('ticket: do-thing');
    expect(out).not.toContain('entryCount');
    expect(out).not.toContain('updated:');
    expect(out).toContain('generated: "2026-04-20T12:00:00Z"');
    expect(out).toContain('# Progress');
    expect(out).toContain('No progress yet.');
  });
});

describe('formatProgressEntry', () => {
  it('formats an entry with a timestamp heading and trimmed body', () => {
    const entry = formatProgressEntry('   Did the thing.   ', '2026-04-20T13:00:00Z');
    expect(entry).toBe('## 2026-04-20T13:00:00Z · progress · human\n\nDid the thing.\n');
  });
});
