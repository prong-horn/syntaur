import { SearchInput } from '../SearchInput';
import { FilterBar } from '../FilterBar';
import {
  ATTRIBUTION_LABELS,
  SESSION_ATTRIBUTIONS,
  type SessionAttribution,
} from '@shared/session-attribution';
import { ARCHIVED_FILTERS, ARCHIVED_LABELS, type ArchivedFilter } from '@shared/session-archived';
import { SESSION_SORTS, type SessionSort } from '@shared/session-sort';
import type { AgentSessionsResponse } from '../../data/types';

const SORT_LABELS: Record<SessionSort, string> = {
  started_desc: 'Newest first',
  started_asc: 'Oldest first',
  duration_desc: 'Longest first',
  duration_asc: 'Shortest first',
  ticket_asc: 'Ticket A-Z',
  agent_asc: 'Agent A-Z',
  spend_desc: 'Most expensive',
  tokens_desc: 'Most tokens',
};

export interface SessionFiltersProps {
  search: string;
  startedFrom: string;
  startedTo: string;
  sort: SessionSort;
  attribution: SessionAttribution;
  archived: ArchivedFilter;
  pageMeta?: AgentSessionsResponse['page'];
  onSearchChange: (value: string) => void;
  onStartedFromChange: (value: string) => void;
  onStartedToChange: (value: string) => void;
  onSortChange: (value: SessionSort) => void;
  onAttributionChange: (value: SessionAttribution) => void;
  onArchivedChange: (value: ArchivedFilter) => void;
}

export function SessionFilters({
  search,
  startedFrom,
  startedTo,
  sort,
  attribution,
  archived,
  pageMeta,
  onSearchChange,
  onStartedFromChange,
  onStartedToChange,
  onSortChange,
  onAttributionChange,
  onArchivedChange,
}: SessionFiltersProps) {
  return (
    <FilterBar>
      <SearchInput
        value={search}
        onChange={onSearchChange}
        placeholder="Search project, ticket, agent, session ID, path, or description"
      />
      <label className="flex min-w-[150px] flex-col gap-1 text-xs font-medium uppercase tracking-[0.08em] text-muted-foreground">
        Started From
        <input
          type="date"
          value={startedFrom}
          onChange={(event) => onStartedFromChange(event.target.value)}
          className="editor-input min-w-[150px]"
        />
      </label>
      <label className="flex min-w-[150px] flex-col gap-1 text-xs font-medium uppercase tracking-[0.08em] text-muted-foreground">
        Started To
        <input
          type="date"
          value={startedTo}
          onChange={(event) => onStartedToChange(event.target.value)}
          className="editor-input min-w-[150px]"
        />
      </label>
      <select
        value={attribution}
        onChange={(event) => onAttributionChange(event.target.value as SessionAttribution)}
        aria-label="Filter sessions by attribution"
        className="editor-input max-w-[240px]"
      >
        {SESSION_ATTRIBUTIONS.map((value) => {
          const count = pageMeta?.attributionCounts?.[value];
          return (
            <option key={value} value={value}>
              {ATTRIBUTION_LABELS[value]}
              {count === undefined ? '' : ` (${count.toLocaleString()})`}
            </option>
          );
        })}
      </select>
      <select
        value={archived}
        onChange={(event) => onArchivedChange(event.target.value as ArchivedFilter)}
        aria-label="Archived session visibility"
        className="editor-input max-w-[200px]"
      >
        {ARCHIVED_FILTERS.map((value) => (
          <option key={value} value={value}>
            {ARCHIVED_LABELS[value]}
          </option>
        ))}
      </select>
      <select
        value={sort}
        onChange={(event) => onSortChange(event.target.value as SessionSort)}
        aria-label="Sort sessions"
        className="editor-input max-w-[200px]"
      >
        {SESSION_SORTS.map((value) => (
          <option key={value} value={value}>
            {SORT_LABELS[value]}
          </option>
        ))}
      </select>
    </FilterBar>
  );
}
