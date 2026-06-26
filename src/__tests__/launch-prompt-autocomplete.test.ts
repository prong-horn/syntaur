import { describe, it, expect } from 'vitest';
import {
  detectActiveToken,
  rankSuggestions,
  applySuggestion,
  tokenWarnings,
} from '../../dashboard/src/lib/launch-prompt-autocomplete';
import { resolveLaunchPrompt } from '../launch/launch-prompt.js';

const KNOWN = new Set(['e2e-dev-cycle', 'keep-records-updated']);

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

describe('rankSuggestions', () => {
  it('empty partial returns reserved tokens first, then all slugs', () => {
    expect(rankSuggestions('', ['e2e-dev-cycle', 'keep-records-updated'])).toEqual([
      'assignment',
      'worktree',
      'e2e-dev-cycle',
      'keep-records-updated',
    ]);
  });

  it('ranks prefix matches before substring matches', () => {
    expect(rankSuggestions('rec', ['my-rec', 'rec-a'])).toEqual(['rec-a', 'my-rec']);
  });

  it('ranks the worktree reserved token by prefix', () => {
    expect(rankSuggestions('work', ['workspace-x'])).toEqual(['worktree', 'workspace-x']);
  });

  it('does not duplicate a playbook literally named assignment or worktree', () => {
    expect(rankSuggestions('', ['assignment', 'worktree', 'x'])).toEqual([
      'assignment',
      'worktree',
      'x',
    ]);
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

describe('tokenWarnings — parity with the server resolveLaunchPrompt', () => {
  // Mirror the real launch box: an assignment with a worktree, so `@assignment`
  // and `@worktree` both resolve (no warn) on the server — matching the
  // dashboard's "reserved tokens never warn" advisory.
  const ctx = {
    id: 'x',
    assignmentDir: '/recs',
    worktreePath: '/wt',
    projectSlug: 'p' as string | null,
    assignmentSlug: 'a',
    knownPlaybookSlugs: KNOWN,
  };
  const cases = [
    '@assignment hi',
    'cd @worktree and build',
    'Run @e2e-dev-cycle now',
    'Use @missing-thing',
    '@FOO and @foo_bar and @foo--bar',
    'plain @ and user@example.com',
    '@assignment then @keep-records-updated and @nope',
    'path @foo.bar/x stops at the dot',
  ];

  it.each(cases)('warning count matches the server for: %s', (text) => {
    const serverWarnings = resolveLaunchPrompt({ template: text, ...ctx }).warnings.length;
    expect(tokenWarnings(text, KNOWN).length).toBe(serverWarnings);
  });

  it('flags an uninstalled slug but not @assignment, @worktree, or a known slug', () => {
    const w = tokenWarnings('@assignment @worktree @e2e-dev-cycle @nope', KNOWN);
    expect(w).toHaveLength(1);
    expect(w[0]).toContain('nope');
  });
});
