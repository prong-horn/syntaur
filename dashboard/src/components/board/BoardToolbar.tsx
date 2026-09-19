import { type RefObject } from 'react';
import { FilterX } from 'lucide-react';
import { FilterBar } from '../FilterBar';
import { SearchInput } from '../SearchInput';
import { ViewToggle } from '../ViewToggle';
import { TableColumnPicker } from '../TableColumnPicker';
import { QueryInput } from '../QueryInput';
import { MultiSelect } from '../ui/MultiSelect';
import { DateRangeControl } from '../ui/DateRangeControl';
import type { BoardFilterActions, BoardFilterState } from '../../hooks/useBoardFilters';
import { GROUPINGS } from '../../hooks/useBoardFilters';
import type { ViewMode } from '@shared/view-prefs-schema';
import type { TableColumnId } from '@shared/view-prefs-schema';
import type { FieldRegistry } from '@shared/query';

export interface BoardToolbarProps {
  state: BoardFilterState;
  actions: BoardFilterActions;
  searchRef: RefObject<HTMLInputElement>;
  registry: FieldRegistry;
  statusOptions: Array<{ value: string; label: string }>;
  priorityOptions: Array<{ value: string; label: string }>;
  templateOptions: Array<{ value: string; label: string }>;
  assigneeOptions: Array<{ value: string; label: string }>;
  projectOptions: Array<{ value: string; label: string }>;
  tagOptions: Array<{ value: string; label: string }>;
  tableColumnVisibility: { hidden: TableColumnId[] };
  onTableColumnVisibilityChange: (next: { hidden: TableColumnId[] }) => void;
}

export function BoardToolbar({
  state,
  actions,
  searchRef,
  registry,
  statusOptions,
  priorityOptions,
  templateOptions,
  assigneeOptions,
  projectOptions,
  tagOptions,
  tableColumnVisibility,
  onTableColumnVisibilityChange,
}: BoardToolbarProps) {
  const effectiveKanbanGrouping = state.grouping === 'type' ? 'type' : 'status';

  return (
    <FilterBar>
      <QueryInput
        className="w-full md:min-w-[320px] md:flex-1"
        value={state.query}
        onChange={actions.setQuery}
        registry={registry}
        valueSources={{
          statuses: statusOptions.map((o) => o.value),
          priorities: priorityOptions.map((o) => o.value),
          types: templateOptions.map((o) => o.value),
          assignees: assigneeOptions.filter((o) => o.value !== '__unassigned__').map((o) => o.value),
          projects: projectOptions.map((o) => o.value),
          tags: tagOptions.map((o) => o.value),
        }}
      />
      {!state.chipsRepresentable ? (
        <span
          className="inline-flex items-center rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-xs font-medium text-amber-700 dark:text-amber-300"
          title="Advanced query — edit in the box; chips are read-only until representable again."
        >
          advanced query
        </span>
      ) : null}
      <SearchInput
        ref={searchRef}
        value={state.search}
        onChange={state.chipsRepresentable ? actions.setSearch : () => {}}
        placeholder="Search tickets or projects"
      />
      <MultiSelect
        ariaLabel="Status filter"
        className="max-w-[180px]"
        allLabel="All statuses"
        disabled={!state.chipsRepresentable}
        options={statusOptions}
        value={state.status}
        onChange={actions.setStatusFilter}
      />
      <MultiSelect
        ariaLabel="Priority filter"
        className="max-w-[180px]"
        allLabel="All priorities"
        disabled={!state.chipsRepresentable}
        options={priorityOptions}
        value={state.priority}
        onChange={actions.setPriorityFilter}
      />
      <MultiSelect
        ariaLabel="Type filter"
        className="max-w-[180px]"
        allLabel="All types"
        disabled={!state.chipsRepresentable}
        options={templateOptions}
        value={state.template}
        onChange={actions.setTemplateFilter}
      />
      <MultiSelect
        ariaLabel="Assignee filter"
        className="max-w-[180px]"
        allLabel="All assignees"
        disabled={!state.chipsRepresentable}
        options={assigneeOptions}
        value={state.assignee}
        onChange={actions.setAssigneeFilter}
      />
      <MultiSelect
        ariaLabel="Project filter"
        className="max-w-[180px]"
        allLabel="All projects"
        disabled={!state.chipsRepresentable}
        options={projectOptions}
        value={state.project}
        onChange={actions.setProjectFilter}
      />
      <MultiSelect
        ariaLabel="Tags filter"
        className="max-w-[180px]"
        allLabel="Any tags"
        disabled={!state.chipsRepresentable}
        options={tagOptions}
        value={state.tags}
        onChange={actions.setTagsFilter}
      />
      <DateRangeControl
        className="max-w-[200px]"
        value={state.dateRange}
        onChange={state.chipsRepresentable ? actions.setDateRange : () => {}}
      />
      <select
        value={state.activity}
        disabled={!state.chipsRepresentable}
        onChange={(e) => actions.setActivityFilter(e.target.value as BoardFilterState['activity'])}
        className="editor-input max-w-[180px]"
        aria-label="Filter by activity"
      >
        <option value="all">All activity</option>
        <option value="stale">Stale only</option>
        <option value="fresh">Fresh only</option>
      </select>
      <select
        value={state.history}
        onChange={(e) => actions.setHistory(e.target.value as BoardFilterState['history'])}
        className="editor-input max-w-[180px]"
        aria-label="Ticket history"
      >
        <option value="recent">Recent</option>
        <option value="all">All history</option>
        <option value="older">Older than…</option>
      </select>
      {state.history === 'older' ? (
        <input
          type="number"
          min={1}
          max={36500}
          value={state.olderThanDays}
          onChange={(e) => actions.setOlderThanDays(Number(e.target.value) || 30)}
          className="editor-input w-[88px]"
          aria-label="Older than days"
        />
      ) : null}
      <select
        value={state.view === 'kanban' ? effectiveKanbanGrouping : state.grouping}
        onChange={(e) => actions.setGrouping(e.target.value as BoardFilterState['grouping'])}
        className="editor-input max-w-[180px]"
        title="Group by"
      >
        {GROUPINGS.map((g) => {
          const unsupported = state.view === 'kanban' && g !== 'status' && g !== 'type' && g !== 'workflow';
          const label = g === 'none' ? 'No grouping' : `Group: ${g.charAt(0).toUpperCase() + g.slice(1)}`;
          return (
            <option key={g} value={g} disabled={unsupported}>
              {unsupported ? `${label} (list only)` : label}
            </option>
          );
        })}
      </select>
      <ViewToggle
        value={state.view}
        onChange={(value) => actions.setView(value as ViewMode)}
        options={[
          { value: 'table', label: 'Table' },
          { value: 'list', label: 'List' },
          { value: 'kanban', label: 'Kanban' },
        ]}
      />
      {state.view === 'table' ? (
        <TableColumnPicker visibility={tableColumnVisibility} onChange={onTableColumnVisibilityChange} />
      ) : null}
      <button type="button" className="shell-action" onClick={actions.clearPrimaryFilters} title="Clear filters">
        <FilterX className="h-4 w-4" />
        <span className="sr-only">Clear filters</span>
      </button>
    </FilterBar>
  );
}
