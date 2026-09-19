import { vi } from 'vitest';
import type { BoardFilterActions, BoardFilterState } from '../../../hooks/useBoardFilters';

export function stubBoardFilterActions(): BoardFilterActions {
  return {
    setView: vi.fn(),
    setStatusFilter: vi.fn(),
    setPriorityFilter: vi.fn(),
    setTemplateFilter: vi.fn(),
    setAssigneeFilter: vi.fn(),
    setTagsFilter: vi.fn(),
    setProjectFilter: vi.fn(),
    setActivityFilter: vi.fn(),
    setQuery: vi.fn(),
    setSortField: vi.fn(),
    setSortDirection: vi.fn(),
    setGrouping: vi.fn(),
    setDateRange: vi.fn(),
    setSearch: vi.fn(),
    setHistory: vi.fn(),
    setOlderThanDays: vi.fn(),
    setProjectVisibility: vi.fn(),
    setPanel: vi.fn(),
    setDialog: vi.fn(),
    clearPrimaryFilters: vi.fn(),
  };
}

export function minimalBoardState(overrides: Partial<BoardFilterState> = {}): BoardFilterState {
  return {
    view: 'kanban',
    status: [],
    template: [],
    priority: [],
    assignee: [],
    tags: [],
    project: [],
    activity: 'all',
    query: '',
    sortField: 'updated',
    sortDirection: 'desc',
    history: 'recent',
    olderThanDays: 30,
    projectVisibility: 'active',
    panel: null,
    dialog: 'new-ticket',
    grouping: 'status',
    dateRange: null,
    search: '',
    chipsRepresentable: true,
    preferenceScope: null,
    density: 'comfortable',
    ...overrides,
  };
}
