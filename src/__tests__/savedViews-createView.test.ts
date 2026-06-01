import { describe, expect, it } from 'vitest';
// savedViews.ts pulls shared schema via `@shared/*` (aliased to src/utils in
// vitest.config.ts), so it loads under the node env. Relative path keeps it
// inside vitest's `include` reach.
import {
  buildCreateViewPayload,
  applyConfig,
  inferLandingRoute,
  DEFAULT_CREATE_VIEW_STATE,
  type ApplyConfigSetters,
  type CreateViewBuilderState,
} from '../../dashboard/src/lib/savedViews';
import { isSavedViewConfig, isProjectDetailCompatible, type SavedView } from '../utils/saved-views-schema.js';

function makeView(workspace: string | null, config: SavedView['config']): SavedView {
  return {
    id: 'v1',
    name: 'n',
    workspace,
    config,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  };
}

describe('buildCreateViewPayload', () => {
  it('default state produces a valid, minimized, global config', () => {
    const payload = buildCreateViewPayload(DEFAULT_CREATE_VIEW_STATE, null);
    expect(isSavedViewConfig(payload.config)).toBe(true);
    expect(payload.workspace).toBe(null);
    expect(payload.config.viewMode).toBe('kanban');
    expect(payload.config.sortField).toBe('updated');
    expect(payload.config.sortDirection).toBe('desc');
    expect(payload.config.filters).toEqual({});
  });

  it('scopes the payload to the passed workspace', () => {
    expect(buildCreateViewPayload(DEFAULT_CREATE_VIEW_STATE, 'syntaur').workspace).toBe('syntaur');
  });

  it('persists MULTI-value filters as arrays', () => {
    const state: CreateViewBuilderState = {
      ...DEFAULT_CREATE_VIEW_STATE,
      filters: {
        status: ['in_progress', 'review'],
        priority: ['high', 'critical'],
        type: ['feature', 'bug'],
        project: ['alpha', 'beta'],
      },
    };
    const { config } = buildCreateViewPayload(state, null);
    expect(isSavedViewConfig(config)).toBe(true);
    expect(config.filters.status).toEqual(['in_progress', 'review']);
    expect(config.filters.priority).toEqual(['high', 'critical']);
    expect(config.filters.type).toEqual(['feature', 'bug']);
    expect(config.filters.project).toEqual(['alpha', 'beta']);
  });

  it('normalizes a LEGACY single-string filter into an array', () => {
    const state = { ...DEFAULT_CREATE_VIEW_STATE, filters: { priority: 'high' } } as CreateViewBuilderState;
    expect(buildCreateViewPayload(state, null).config.filters.priority).toEqual(['high']);
  });

  it('drops empty/whitespace + "all" tokens and dedupes', () => {
    const state: CreateViewBuilderState = {
      ...DEFAULT_CREATE_VIEW_STATE,
      filters: { assignee: ['  ', '', 'all', '  claude  ', 'claude'] },
    };
    const { config } = buildCreateViewPayload(state, null);
    expect(config.filters.assignee).toEqual(['claude']);
  });

  it('an all-empty multi field minimizes away entirely', () => {
    const state: CreateViewBuilderState = {
      ...DEFAULT_CREATE_VIEW_STATE,
      filters: { status: [], priority: ['all'] },
    };
    expect(buildCreateViewPayload(state, null).config.filters).toEqual({});
  });
});

describe('buildCreateViewPayload — faithful capture (NO route coercion, Decision 11)', () => {
  it('keeps list + activity even with a single concrete project', () => {
    const state: CreateViewBuilderState = {
      ...DEFAULT_CREATE_VIEW_STATE,
      viewMode: 'list',
      filters: { project: ['foo'], activity: 'stale' },
    };
    const { config } = buildCreateViewPayload(state, null);
    // Capture is faithful — routing (inferLandingRoute) decides the surface.
    expect(config.viewMode).toBe('list');
    expect(config.filters.activity).toBe('stale');
    expect(config.filters.project).toEqual(['foo']);
  });

  it('keeps table view mode for a concrete project too', () => {
    const state: CreateViewBuilderState = {
      ...DEFAULT_CREATE_VIEW_STATE,
      viewMode: 'table',
      filters: { project: ['foo'] },
    };
    expect(buildCreateViewPayload(state, null).config.viewMode).toBe('table');
  });
});

describe('applyConfig round-trip (multi-value, applyable)', () => {
  it('drives array setters from a built config (incl. type)', () => {
    const state: CreateViewBuilderState = {
      viewMode: 'table',
      filters: {
        status: ['in_progress', 'review'],
        priority: ['high'],
        type: ['feature'],
        assignee: ['claude'],
      },
      sortField: 'priority',
      sortDirection: 'asc',
    };
    const { config } = buildCreateViewPayload(state, 'syntaur');
    const view = makeView('syntaur', config);

    const seen: Record<string, unknown> = {};
    const setters: ApplyConfigSetters = {
      setViewMode: (v) => (seen.viewMode = v),
      setStatusFilter: (v) => (seen.status = v),
      setTypeFilter: (v) => (seen.type = v),
      setPriorityFilter: (v) => (seen.priority = v),
      setAssigneeFilter: (v) => (seen.assignee = v),
      setProjectFilter: (v) => (seen.project = v),
      setActivityFilter: (v) => (seen.activity = v),
      setSortField: (v) => (seen.sortField = v),
      setSortDirection: (v) => (seen.sortDirection = v),
    };
    applyConfig(view, setters);

    expect(seen.viewMode).toBe('table');
    expect(seen.status).toEqual(['in_progress', 'review']);
    expect(seen.type).toEqual(['feature']);
    expect(seen.priority).toEqual(['high']);
    expect(seen.assignee).toEqual(['claude']);
    expect(seen.project).toEqual([]); // unset filter applies as empty (no constraint)
    expect(seen.activity).toBe('all');
    expect(seen.sortField).toBe('priority');
    expect(seen.sortDirection).toBe('asc');
  });

  it('round-trips the __unassigned__ sentinel inside an array', () => {
    const state: CreateViewBuilderState = {
      ...DEFAULT_CREATE_VIEW_STATE,
      filters: { assignee: ['__unassigned__', 'claude'] },
    };
    const { config } = buildCreateViewPayload(state, null);
    const seen: Record<string, unknown> = {};
    applyConfig(makeView(null, config), { setAssigneeFilter: (v) => (seen.assignee = v) });
    expect(seen.assignee).toEqual(['__unassigned__', 'claude']);
  });
});

describe('tags / dateRange / search persistence + round-trip', () => {
  it('persists tags + dateRange + search and applyConfig round-trips them', () => {
    const state: CreateViewBuilderState = {
      ...DEFAULT_CREATE_VIEW_STATE,
      filters: {
        tags: ['backend', 'urgent'],
        dateRange: { field: 'updated', preset: 'last_7d' },
        search: '  login  ',
      },
    };
    const { config } = buildCreateViewPayload(state, null);
    expect(isSavedViewConfig(config)).toBe(true);
    expect(config.filters.tags).toEqual(['backend', 'urgent']);
    expect(config.filters.dateRange).toEqual({ field: 'updated', preset: 'last_7d' });
    expect(config.filters.search).toBe('login'); // trimmed

    const seen: Record<string, unknown> = {};
    applyConfig(makeView(null, config), {
      setTagsFilter: (v) => (seen.tags = v),
      setDateRange: (v) => (seen.dateRange = v),
      setSearch: (v) => (seen.search = v),
    });
    expect(seen.tags).toEqual(['backend', 'urgent']);
    expect(seen.dateRange).toEqual({ field: 'updated', preset: 'last_7d', from: '', to: '' });
    expect(seen.search).toBe('login');
  });

  it('isProjectDetailCompatible: search excludes, dateRange/tags do NOT', () => {
    const base = buildCreateViewPayload({ ...DEFAULT_CREATE_VIEW_STATE, filters: { project: ['foo'] } }, null).config;
    expect(isProjectDetailCompatible(base, 'foo')).toBe(true);
    const withTags = buildCreateViewPayload({ ...DEFAULT_CREATE_VIEW_STATE, filters: { project: ['foo'], tags: ['x'] } }, null).config;
    expect(isProjectDetailCompatible(withTags, 'foo')).toBe(true);
    const withDate = buildCreateViewPayload({ ...DEFAULT_CREATE_VIEW_STATE, filters: { project: ['foo'], dateRange: { field: 'created', preset: 'last_30d' } } }, null).config;
    expect(isProjectDetailCompatible(withDate, 'foo')).toBe(true);
    const withSearch = buildCreateViewPayload({ ...DEFAULT_CREATE_VIEW_STATE, filters: { project: ['foo'], search: 'q' } }, null).config;
    expect(isProjectDetailCompatible(withSearch, 'foo')).toBe(false);
  });
});

describe('inferLandingRoute for built views (compatibility-aware)', () => {
  function routeFor(
    workspace: string | null,
    filters: CreateViewBuilderState['filters'] = {},
  ): string {
    const { config } = buildCreateViewPayload({ ...DEFAULT_CREATE_VIEW_STATE, filters }, workspace);
    return inferLandingRoute(makeView(workspace, config));
  }

  it('global view → global assignments list', () => {
    expect(routeFor(null)).toBe('/assignments?loadView=v1');
  });

  it('workspace view → workspace-prefixed assignments list', () => {
    expect(routeFor('syntaur')).toBe('/w/syntaur/assignments?loadView=v1');
  });

  it('ungrouped view → /w/_ungrouped assignments list', () => {
    expect(routeFor('_ungrouped')).toBe('/w/_ungrouped/assignments?loadView=v1');
  });

  it('single concrete project, no activity → project route on the assignments tab', () => {
    expect(routeFor(null, { project: ['my-proj'] })).toBe(
      '/projects/my-proj?tab=assignments&loadView=v1',
    );
  });

  it('single concrete project + activity → GLOBAL list (ProjectDetail has no activity)', () => {
    expect(routeFor(null, { project: ['my-proj'], activity: 'stale' })).toBe(
      '/assignments?loadView=v1',
    );
  });

  it('MULTI-project view → global list (no single ProjectDetail to land on)', () => {
    expect(routeFor(null, { project: ['a', 'b'] })).toBe('/assignments?loadView=v1');
  });

  it('__standalone__ sentinel → assignments list, NOT /projects/__standalone__', () => {
    expect(routeFor(null, { project: ['__standalone__'] })).toBe('/assignments?loadView=v1');
  });

  it('LEGACY scalar project + activity config → global list (Decision 10/11)', () => {
    // A view persisted before this feature can carry scalar project + activity.
    const view = makeView(null, {
      viewMode: 'list',
      filters: { project: 'foo', activity: 'stale' },
      sortField: 'updated',
      sortDirection: 'desc',
      listSectionVisibility: { collapsed: [] },
      kanbanColumnVisibility: { hidden: [] },
      tableColumnVisibility: { hidden: [] },
    });
    expect(inferLandingRoute(view)).toBe('/assignments?loadView=v1');
  });
});
