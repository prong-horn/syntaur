import { describe, it, expect } from 'vitest';
import { renderProgress, formatProgressEntry } from '../templates/index.js';
import { parseProgress } from '../dashboard/parser.js';

describe('renderProgress', () => {
  it('produces valid frontmatter with zero entries', () => {
    const out = renderProgress({
      assignment: 'do-thing',
      timestamp: '2026-04-20T12:00:00Z',
    });
    expect(out).toContain('assignment: do-thing');
    expect(out).toContain('entryCount: 0');
    expect(out).toContain('generated: "2026-04-20T12:00:00Z"');
    expect(out).toContain('updated: "2026-04-20T12:00:00Z"');
    expect(out).toContain('# Progress');
    expect(out).toContain('No progress yet.');
  });
});

describe('formatProgressEntry', () => {
  it('formats an entry with a timestamp heading and trimmed body', () => {
    const entry = formatProgressEntry('   Did the thing.   ', '2026-04-20T13:00:00Z');
    expect(entry).toBe('## 2026-04-20T13:00:00Z\n\nDid the thing.\n');
  });
});

describe('parseProgress round-trip', () => {
  it('empty template parses to zero entries', () => {
    const template = renderProgress({
      assignment: 'a-slug',
      timestamp: '2026-04-20T10:00:00Z',
    });
    const parsed = parseProgress(template);
    expect(parsed.assignment).toBe('a-slug');
    expect(parsed.entryCount).toBe(0);
    // Sentinel "No progress yet." is not a valid `## ` entry, so entries are empty.
    expect(parsed.entries).toHaveLength(0);
  });

  it('round-trips a file with multiple entries', () => {
    const file = [
      '---',
      'assignment: example',
      'entryCount: 2',
      'generated: "2026-04-20T10:00:00Z"',
      'updated: "2026-04-20T14:00:00Z"',
      '---',
      '',
      '# Progress',
      '',
      '## 2026-04-20T14:00:00Z',
      '',
      'Second entry — newest.',
      '',
      '## 2026-04-20T12:00:00Z',
      '',
      'First entry — older.',
      '',
    ].join('\n');

    const parsed = parseProgress(file);
    expect(parsed.assignment).toBe('example');
    expect(parsed.entryCount).toBe(2);
    expect(parsed.updated).toBe('2026-04-20T14:00:00Z');
    expect(parsed.entries).toHaveLength(2);
    expect(parsed.entries[0].timestamp).toBe('2026-04-20T14:00:00Z');
    expect(parsed.entries[0].body).toBe('Second entry — newest.');
    expect(parsed.entries[1].timestamp).toBe('2026-04-20T12:00:00Z');
    expect(parsed.entries[1].body).toBe('First entry — older.');
  });
});
