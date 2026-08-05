import { describe, expect, it } from 'vitest';
import { formatDuration } from '../../dashboard/src/lib/format';
import { buildShellMeta, getSidebarSection, isSidebarItemActive } from '../../dashboard/src/lib/routes';
import { STATIC_PAGES } from '../../dashboard/src/hotkeys/paletteIndex';

describe('dashboard route helpers', () => {
  it('maps agent sessions routes to the correct shell title and sidebar item', () => {
    expect(buildShellMeta('/agent-sessions').title).toBe('Agent Sessions');
    expect(getSidebarSection('/agent-sessions')).toBe('/agent-sessions');
    expect(isSidebarItemActive('/agent-sessions', '/agent-sessions')).toBe(true);
    expect(isSidebarItemActive('/agent-sessions', '/servers')).toBe(false);
  });

  it('keeps the workspace-prefixed agent sessions route mapping to the global nav entry', () => {
    // Agent Sessions moved out of the per-workspace sidebar list into the global
    // Operations group, but /w/:workspace/agent-sessions is still a live route —
    // it must still light up the one remaining nav entry rather than nothing.
    expect(getSidebarSection('/w/syntaur/agent-sessions')).toBe('/agent-sessions');
    expect(isSidebarItemActive('/w/syntaur/agent-sessions', '/agent-sessions')).toBe(true);
  });

  it('maps the workflow route to the correct shell title and sidebar item', () => {
    expect(buildShellMeta('/workflow').title).toBe('Workflow');
    expect(getSidebarSection('/workflow')).toBe('/workflow');
    expect(isSidebarItemActive('/workflow', '/workflow')).toBe(true);
    expect(isSidebarItemActive('/workflow', '/settings')).toBe(false);
  });

  it('exposes the workflow page in the command palette index', () => {
    const entry = STATIC_PAGES.find((page) => page.basePath === '/workflow');
    expect(entry).toBeDefined();
    expect(entry?.title).toBe('Workflow');
  });

  it('exposes the agent sessions page in the command palette index', () => {
    const entry = STATIC_PAGES.find((page) => page.basePath === '/agent-sessions');
    expect(entry).toBeDefined();
    expect(entry?.title).toBe('Agent Sessions');
    // Without this the only palette hit for "sessions" was Servers, which
    // claims the keyword for tracked dev servers.
    expect(entry?.keywords).toContain('sessions');
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
