import { describe, expect, it } from 'vitest';
import {
  boardPreferenceScope,
  boardUrlParamsEqual,
  parseBoardUrlParams,
  serializeBoardUrlParams,
} from '../boardUrlParams';

describe('boardUrlParams', () => {
  it('parses repeated keys and legacy comma-separated status', () => {
    const repeated = parseBoardUrlParams(new URLSearchParams('status=in_progress&status=review&project=alpha'));
    expect(repeated.status).toEqual(['in_progress', 'review']);
    expect(repeated.project).toEqual(['alpha']);

    const legacy = parseBoardUrlParams(new URLSearchParams('status=in_progress,review'));
    expect(legacy.status).toEqual(['in_progress', 'review']);
  });

  it('distinguishes absent vs explicit empty project', () => {
    const absent = parseBoardUrlParams(new URLSearchParams(''));
    expect(absent.project).toEqual([]);
    expect(absent.projectCleared).toBe(false);

    const cleared = parseBoardUrlParams(new URLSearchParams('project='));
    expect(cleared.project).toEqual([]);
    expect(cleared.projectCleared).toBe(true);
  });

  it('resolves preference scope from URL project slugs only', () => {
    expect(boardPreferenceScope([])).toBeNull();
    expect(boardPreferenceScope(['a', 'b'])).toBeNull();
    expect(boardPreferenceScope(['my-proj'])).toBe('p:my-proj');
  });

  it('round-trips multi-value filters and omits defaults', () => {
    const base = new URLSearchParams('view=table&history=older&olderThanDays=45');
    const next = serializeBoardUrlParams(base, {
      status: ['done'],
      tags: ['a,b', 'c'],
      project: ['p1'],
      history: 'recent',
      olderThanDays: 30,
      panel: null,
    });
    expect(next.getAll('status')).toEqual(['done']);
    expect(next.getAll('tags')).toEqual(['a,b', 'c']);
    expect(next.get('history')).toBeNull();
    expect(next.get('olderThanDays')).toBeNull();
  });

  it('serializes explicit project clear', () => {
    const out = serializeBoardUrlParams(new URLSearchParams('project=old'), { project: 'clear' });
    expect(out.getAll('project')).toEqual(['']);
  });

  it('compares param strings for equality', () => {
    expect(boardUrlParamsEqual(new URLSearchParams('a=1'), new URLSearchParams('a=1'))).toBe(true);
    expect(boardUrlParamsEqual(new URLSearchParams('a=1'), new URLSearchParams('a=2'))).toBe(false);
  });
});
