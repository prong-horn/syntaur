import { describe, expect, it } from 'vitest';
// savedViews.ts imports @shared only as `import type` (erased at runtime), so it
// loads under node with no alias. Relative path keeps it inside vitest's reach.
import {
  buildCreateViewPayload,
  applyConfig,
  inferLandingRoute,
  DEFAULT_CREATE_VIEW_STATE,
  type ApplyConfigSetters,
  type CreateViewBuilderState,
} from '../../dashboard/src/lib/savedViews';
import { isSavedViewConfig, type SavedView } from '../utils/saved-views-schema.js';

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
    // All-default filters minimize away to {}.
    expect(payload.config.filters).toEqual({});
  });

  it('scopes the payload to the passed workspace', () => {
    const payload = buildCreateViewPayload(DEFAULT_CREATE_VIEW_STATE, 'syntaur');
    expect(payload.workspace).toBe('syntaur');
  });

  it('preserves a non-default filter through minimization', () => {
    const state: CreateViewBuilderState = {
      ...DEFAULT_CREATE_VIEW_STATE,
      filters: { priority: 'high' },
    };
    const payload = buildCreateViewPayload(state, null);
    expect(payload.config.filters.priority).toBe('high');
    expect(isSavedViewConfig(payload.config)).toBe(true);
  });

  it('normalizes an empty/whitespace assignee to undefined (never persists "")', () => {
    const state: CreateViewBuilderState = {
      ...DEFAULT_CREATE_VIEW_STATE,
      filters: { assignee: '  ' },
    };
    const payload = buildCreateViewPayload(state, null);
    expect(payload.config.filters.assignee).toBeUndefined();
  });

  it('keeps a real assignee value (trimmed)', () => {
    const state: CreateViewBuilderState = {
      ...DEFAULT_CREATE_VIEW_STATE,
      filters: { assignee: '  claude  ' },
    };
    const payload = buildCreateViewPayload(state, null);
    expect(payload.config.filters.assignee).toBe('claude');
  });
});

describe('buildCreateViewPayload concrete-project coercion (round-trip safety)', () => {
  // A concrete project routes Apply to ProjectDetail, which has no activity
  // filter and coerces 'list' -> 'kanban'. The saved config must match.
  it('coerces list -> kanban when a concrete project is set', () => {
    const state: CreateViewBuilderState = {
      ...DEFAULT_CREATE_VIEW_STATE,
      viewMode: 'list',
      filters: { project: 'foo' },
    };
    const payload = buildCreateViewPayload(state, null);
    expect(payload.config.viewMode).toBe('kanban');
  });

  it('keeps table view mode for a concrete project (ProjectDetail supports table)', () => {
    const state: CreateViewBuilderState = {
      ...DEFAULT_CREATE_VIEW_STATE,
      viewMode: 'table',
      filters: { project: 'foo' },
    };
    expect(buildCreateViewPayload(state, null).config.viewMode).toBe('table');
  });

  it('drops the activity filter when a concrete project is set', () => {
    const state: CreateViewBuilderState = {
      ...DEFAULT_CREATE_VIEW_STATE,
      filters: { project: 'foo', activity: 'stale' },
    };
    const payload = buildCreateViewPayload(state, null);
    expect(payload.config.filters.activity).toBeUndefined();
    expect(payload.config.filters.project).toBe('foo');
  });

  it('keeps list + activity for the __standalone__ sentinel (routes to global list)', () => {
    const state: CreateViewBuilderState = {
      ...DEFAULT_CREATE_VIEW_STATE,
      viewMode: 'list',
      filters: { project: '__standalone__', activity: 'stale' },
    };
    const payload = buildCreateViewPayload(state, null);
    expect(payload.config.viewMode).toBe('list');
    expect(payload.config.filters.activity).toBe('stale');
    expect(payload.config.filters.project).toBe('__standalone__');
  });

  it('keeps list + activity when no project is set', () => {
    const state: CreateViewBuilderState = {
      ...DEFAULT_CREATE_VIEW_STATE,
      viewMode: 'list',
      filters: { activity: 'fresh' },
    };
    const payload = buildCreateViewPayload(state, null);
    expect(payload.config.viewMode).toBe('list');
    expect(payload.config.filters.activity).toBe('fresh');
  });
});

describe('applyConfig round-trip (config is applyable)', () => {
  it('drives setters from a built config', () => {
    const state: CreateViewBuilderState = {
      viewMode: 'table',
      filters: { status: 'in_progress', priority: 'high', assignee: 'claude' },
      sortField: 'priority',
      sortDirection: 'asc',
    };
    const { config } = buildCreateViewPayload(state, 'syntaur');
    const view = makeView('syntaur', config);

    const seen: Record<string, unknown> = {};
    const setters: ApplyConfigSetters = {
      setViewMode: (v) => (seen.viewMode = v),
      setStatusFilter: (v) => (seen.status = v),
      setPriorityFilter: (v) => (seen.priority = v),
      setAssigneeFilter: (v) => (seen.assignee = v),
      setProjectFilter: (v) => (seen.project = v),
      setActivityFilter: (v) => (seen.activity = v),
      setSortField: (v) => (seen.sortField = v),
      setSortDirection: (v) => (seen.sortDirection = v),
    };
    applyConfig(view, setters);

    expect(seen.viewMode).toBe('table');
    expect(seen.status).toBe('in_progress');
    expect(seen.priority).toBe('high');
    expect(seen.assignee).toBe('claude');
    expect(seen.project).toBe('all'); // unset filter applies as 'all'
    expect(seen.sortField).toBe('priority');
    expect(seen.sortDirection).toBe('asc');
  });
});

describe('inferLandingRoute for built views', () => {
  function routeFor(workspace: string | null, project?: string): string {
    const state: CreateViewBuilderState = {
      ...DEFAULT_CREATE_VIEW_STATE,
      filters: project ? { project } : {},
    };
    const { config } = buildCreateViewPayload(state, workspace);
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

  it('project-filtered view → project route on the assignments tab', () => {
    expect(routeFor(null, 'my-proj')).toBe(
      '/projects/my-proj?tab=assignments&loadView=v1',
    );
  });

  it('__standalone__ sentinel → assignments list, NOT /projects/__standalone__', () => {
    expect(routeFor(null, '__standalone__')).toBe('/assignments?loadView=v1');
  });
});
