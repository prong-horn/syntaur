import { describe, expect, it } from 'vitest';
import { LEGACY_ROUTE_TABLE, resolveLegacyRoute, stripWorkspacePrefix } from '../legacyRoutes';

describe('legacyRoutes', () => {
  it('redirects root and tickets', () => {
    expect(resolveLegacyRoute('/').destination).toBe('/inbox');
    expect(resolveLegacyRoute('/tickets', '?view=table', '#x').destination).toBe('/board?view=table#x');
    expect(resolveLegacyRoute('/tickets', '?status=review', '#x').destination).toBe(
      '/board?status=review#x',
    );
    expect(resolveLegacyRoute('/projects/qa-atlas', '?tab=archive', '#keep').destination).toBe(
      '/board?project=qa-atlas&panel=project#keep',
    );
  });

  it('redirects projects and archive', () => {
    expect(resolveLegacyRoute('/projects').destination).toContain('panel=projects');
    expect(resolveLegacyRoute('/archive').destination).toContain('projectVisibility=archived');
    expect(resolveLegacyRoute('/projects/my-slug', '?tab=dependencies').destination).toBe(
      '/board?project=my-slug&panel=dependencies',
    );
    expect(resolveLegacyRoute('/projects/my-slug/edit').destination).toContain('dialog=edit-project');
    expect(resolveLegacyRoute('/projects/my-slug/new').destination).toContain('dialog=new-ticket');
    expect(resolveLegacyRoute('/create/project').destination).toContain('dialog=new-project');
    const conflicting = new URL(resolveLegacyRoute('/projects/my-slug', '?project=wrong&tab=overview').destination!, 'http://local');
    expect(conflicting.searchParams.getAll('project')).toEqual(['my-slug']);
  });

  it('redirects sessions, usage, library, help, and ticket edits', () => {
    expect(resolveLegacyRoute('/agent-sessions').destination).toBe('/sessions');
    expect(resolveLegacyRoute('/agent-sessions/sess-1', '', '#pane').destination).toBe(
      '/sessions?session=sess-1#pane',
    );
    expect(resolveLegacyRoute('/usage', '?window=7d&project=alpha').destination).toContain('usageWindow=7d');
    expect(resolveLegacyRoute('/usage', '?window=7d&project=alpha').destination).toContain('panel=usage');
    expect(resolveLegacyRoute('/agents/new').destination).toBe('/library/agents/new');
    expect(resolveLegacyRoute('/playbooks/create').destination).toBe('/library/playbooks/create');
    expect(resolveLegacyRoute('/help').destination).toBe('/settings?section=readme');
    expect(resolveLegacyRoute('/t/abc/edit', '?tab=chat', '#msg').destination).toBe(
      '/t/abc?tab=chat&edit=ticket#msg',
    );
    expect(resolveLegacyRoute('/t/abc/plan/edit', '?foo=bar', '#plan').destination).toBe(
      '/t/abc?foo=bar&edit=plan#plan',
    );
  });

  it('strips workspace prefix once', () => {
    expect(stripWorkspacePrefix('/w/ws-1/tickets')).toBe('/tickets');
    expect(resolveLegacyRoute('/w/ws-1/tickets').destination).toBe('/board');
  });

  it('documents the full route table for integrators', () => {
    expect(LEGACY_ROUTE_TABLE.length).toBeGreaterThanOrEqual(20);
  });
});
