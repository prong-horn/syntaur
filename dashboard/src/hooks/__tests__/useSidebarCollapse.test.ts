import { describe, expect, it } from 'vitest';
import { applyToggle, parseCollapse, type CollapseMap } from '../useSidebarCollapse';

// NOTE: these exercise the pure storage helpers only. The dashboard test dirs
// are not wired into the default root vitest runner (which includes only
// `src/__tests__/**`), so this file is colocated for parity with
// `wsManager.test.ts` and ready if a dashboard runner is added — it is not
// CI-enforced today. The authoritative gate is `npm run build --prefix dashboard`.

describe('parseCollapse', () => {
  it('returns an empty map for null / empty input', () => {
    expect(parseCollapse(null)).toEqual({});
    expect(parseCollapse('')).toEqual({});
  });

  it('returns an empty map for malformed JSON', () => {
    expect(parseCollapse('{not json')).toEqual({});
  });

  it('ignores non-object / array payloads', () => {
    expect(parseCollapse('42')).toEqual({});
    expect(parseCollapse('"str"')).toEqual({});
    expect(parseCollapse('[true, false]')).toEqual({});
  });

  it('keeps only boolean-valued keys', () => {
    expect(parseCollapse('{"library":true,"board":false,"bogus":"x","n":1}')).toEqual({
      library: true,
      board: false,
    });
  });
});

describe('applyToggle', () => {
  it('treats a missing key as expanded (false) and flips it to collapsed', () => {
    expect(applyToggle({}, 'library')).toEqual({ library: true });
  });

  it('flips an existing value', () => {
    expect(applyToggle({ board: true }, 'board')).toEqual({ board: false });
  });

  it('does not mutate the input map', () => {
    const input: CollapseMap = { library: true };
    const out = applyToggle(input, 'board');
    expect(input).toEqual({ library: true });
    expect(out).toEqual({ library: true, board: true });
  });

  it('namespaces workspace keys independently of group ids', () => {
    const out = applyToggle({ operations: true }, 'ws:syntaur');
    expect(out).toEqual({ operations: true, 'ws:syntaur': true });
  });
});
