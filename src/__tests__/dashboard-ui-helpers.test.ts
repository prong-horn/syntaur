import { describe, expect, it } from 'vitest';
import { formatDuration } from '../../dashboard/src/lib/format';
import { buildShellMeta, getSidebarSection, isSidebarItemActive } from '../../dashboard/src/lib/routes';
import { SIDEBAR_SECTIONS } from '../../dashboard/src/lib/routes';

describe('dashboard route helpers', () => {
  it('maps sessions routes to the correct shell title and sidebar item', () => {
    expect(buildShellMeta('/sessions').title).toBe('Sessions');
    expect(getSidebarSection('/sessions')).toBe('/sessions');
    expect(isSidebarItemActive('/sessions', '/sessions')).toBe(true);
    expect(isSidebarItemActive('/sessions', '/library/playbooks')).toBe(false);
  });

  it('exposes exactly the primary sidebar destinations', () => {
    expect(SIDEBAR_SECTIONS).toEqual(['/inbox', '/board', '/sessions', '/library/playbooks', '/settings']);
  });
});

describe('formatDuration', () => {
  it('keeps short sessions in minutes', () => {
    expect(formatDuration('2026-03-20T10:00:00Z', '2026-03-20T10:19:00Z')).toBe('19m');
  });

  it('formats same-day long sessions as hours and minutes', () => {
    expect(formatDuration('2026-03-20T10:00:00Z', '2026-03-20T13:07:00Z')).toBe('3h 7m');
  });

  it('formats multi-day sessions as days and hours', () => {
    expect(formatDuration('2026-03-20T10:00:00Z', '2026-03-23T13:00:00Z')).toBe('3d 3h');
  });
});
