import { describe, it, expect } from 'vitest';
import { rankAll, scoreField } from '../fuzzy';

const entry = (type: string, title: string) => ({ type, title });

describe('fuzzy.rankAll (R5c)', () => {
  it('"ass" prefers Assignments over Decision Record', () => {
    const r = rankAll('ass', [entry('page', 'Assignments'), entry('page', 'Decision Record')]);
    expect(r[0].title).toBe('Assignments');
  });

  it('"dr" prefers Draft over Decision Record', () => {
    const r = rankAll('dr', [entry('page', 'Decision Record'), entry('page', 'Draft')]);
    expect(r[0].title).toBe('Draft');
  });

  it('"mis" prefers Missions over Prime Mission', () => {
    const r = rankAll('mis', [entry('page', 'Prime Mission'), entry('page', 'Missions')]);
    expect(r[0].title).toBe('Missions');
  });

  it('empty query keeps original order', () => {
    const r = rankAll('', [entry('page', 'B'), entry('page', 'A')]);
    expect(r.map((x) => x.title)).toEqual(['B', 'A']);
  });

  it('no match returns empty', () => {
    const r = rankAll('zzz', [entry('page', 'Missions')]);
    expect(r).toHaveLength(0);
  });

  it('tie-break: shorter title wins at equal score', () => {
    // Both "ab" and "abc" get a prefix hit; shorter wins.
    const r = rankAll('a', [entry('page', 'abc'), entry('page', 'ab')]);
    expect(r[0].title).toBe('ab');
  });

  it('case-insensitive matching', () => {
    const r = rankAll('MIS', [entry('page', 'Missions')]);
    expect(r).toHaveLength(1);
    expect(r[0].title).toBe('Missions');
  });
});

describe('fuzzy.scoreField', () => {
  it('prefix match scores higher than mid-word', () => {
    expect(scoreField('a', 'abc')).toBeGreaterThan(scoreField('a', 'bac'));
  });

  it('consecutive match bonus applies', () => {
    // "ab" in "ab" = prefix (30) + match1 (100) + consec (20) + match2 (100) = 250
    // "ab" in "aXb" = prefix (30) + match1 (100) + gap (-1) + match2 (100) = 229
    expect(scoreField('ab', 'ab')).toBeGreaterThan(scoreField('ab', 'aXb'));
  });

  it('word-boundary bonus applies', () => {
    // Greedy matcher takes the first 'p' — so put the word-boundary 'p' first.
    // "pilot" (prefix, 30) + match (100) = 130
    // "xpilot" (no prefix, no boundary) + match (100) + gap (-1) = 99
    expect(scoreField('p', 'pilot')).toBeGreaterThan(scoreField('p', 'xpilot'));
    // Word-boundary bonus: 'p' after '-' scores higher than after 'a'.
    expect(scoreField('p', 'x-p')).toBeGreaterThan(scoreField('p', 'xap'));
  });

  it('unmatched char returns -Infinity', () => {
    expect(scoreField('z', 'abc')).toBe(-Infinity);
  });
});
