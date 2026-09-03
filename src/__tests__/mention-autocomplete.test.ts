import { describe, it, expect } from 'vitest';
import {
  detectActiveToken,
  applySuggestion,
} from '../../dashboard/src/lib/mention-autocomplete';

describe('detectActiveToken', () => {
  it('detects the token the caret sits at the end of', () => {
    expect(detectActiveToken('Run @e2e', 8)).toEqual({ start: 4, end: 8, partial: 'e2e' });
  });

  it('detects an empty partial right after @', () => {
    expect(detectActiveToken('Run @', 5)).toEqual({ start: 4, end: 5, partial: '' });
  });

  it('returns the full token range when the caret is mid-token', () => {
    expect(detectActiveToken('@foobar', 4)).toEqual({ start: 0, end: 7, partial: 'foo' });
  });

  it('returns null for an @ that is not at a word boundary (email)', () => {
    expect(detectActiveToken('user@example', 12)).toBeNull();
  });

  it('returns null when the caret is not inside a token', () => {
    expect(detectActiveToken('hello world', 5)).toBeNull();
  });
});

describe('applySuggestion', () => {
  it('replaces the token range with @<suggestion> and moves the caret', () => {
    const range = detectActiveToken('Run @e2', 7)!;
    expect(applySuggestion('Run @e2', range, 'e2e-dev-cycle')).toEqual({
      text: 'Run @e2e-dev-cycle',
      caret: 18,
    });
  });
});
