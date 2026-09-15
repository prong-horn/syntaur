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
  it('names the journal tab for each record kind', () => {
    expect(recordFiledCopy({ kind: 'decision', ref: '2026-09-07T12:00:00Z', label: 'decision entry' })).toBe(
      'Filed as decision entry (2026-09-07T12:00:00Z) — see the Journal tab',
    );
    expect(recordFiledCopy({ kind: 'progress', ref: '2026-09-07T12:00:00Z', label: 'progress entry' })).toBe(
      'Filed as progress entry (2026-09-07T12:00:00Z) — see the Journal tab',
    );
    expect(recordFiledCopy({ kind: 'note', ref: '2026-09-07T12:01:00Z', label: 'note entry' })).toBe(
      'Filed as note entry (2026-09-07T12:01:00Z) — see the Journal tab',
    );
  });
});
