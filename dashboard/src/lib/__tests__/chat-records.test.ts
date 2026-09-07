import { describe, expect, it } from 'vitest';
import { defaultRecordTitle, recordFiledCopy } from '../chat-records';

describe('defaultRecordTitle', () => {
  it('strips a leading heading marker', () => {
    expect(defaultRecordTitle('## Use caching\nDetails here.')).toBe('Use caching');
  });

  it('cuts a long paragraph at a word boundary', () => {
    const long = 'word '.repeat(30).trim();
    const title = defaultRecordTitle(long);
    expect(title.endsWith('…')).toBe(true);
    expect(title.length).toBeLessThanOrEqual(81);
  });

  it('skips leading blank lines', () => {
    expect(defaultRecordTitle('\n\nActual title\nBody')).toBe('Actual title');
  });

  it('returns Untitled decision for empty text', () => {
    expect(defaultRecordTitle('   \n  ')).toBe('Untitled decision');
  });
});

describe('recordFiledCopy', () => {
  it('names the tab for each record kind', () => {
    expect(recordFiledCopy({ kind: 'decision', ref: 'Decision 6', label: 'Decision 6: Use X' })).toBe(
      'Filed as Decision 6 — see the Decisions tab',
    );
    expect(recordFiledCopy({ kind: 'progress', ref: '2026-09-07T12:00:00Z', label: 'a progress entry' })).toBe(
      'Filed as a progress entry — see the Progress tab',
    );
    expect(recordFiledCopy({ kind: 'comment', ref: 'abc', label: 'a note comment' })).toBe(
      'Filed as a note comment — see the Comments tab',
    );
  });
});
