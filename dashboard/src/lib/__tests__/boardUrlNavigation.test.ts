import { describe, expect, it } from 'vitest';
import { boardUrlNavigateOptions, boardUrlUsesReplace } from '../boardUrlNavigation';

describe('boardUrlNavigation', () => {
  it('replaces bootstrap and preference sync without stacking history', () => {
    expect(boardUrlUsesReplace('bootstrap')).toBe(true);
    expect(boardUrlUsesReplace('preference-sync')).toBe(true);
    expect(boardUrlNavigateOptions('bootstrap')).toEqual({ replace: true });
  });

  it('pushes ephemeral opens and replaces explicit closes', () => {
    expect(boardUrlUsesReplace('open-ephemeral')).toBe(false);
    expect(boardUrlUsesReplace('close-ephemeral')).toBe(true);
    expect(boardUrlNavigateOptions('open-ephemeral')).toEqual({ replace: false });
  });
});
