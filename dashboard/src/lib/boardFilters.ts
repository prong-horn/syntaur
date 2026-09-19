/**
 * Pure helpers for merging board filter state with view-prefs.
 * The saved `filters.project` value is never read for filtering and is preserved
 * byte-for-byte on writes (deep-merge omits project when persisting).
 */
import {
  mergeForScope,
  toFilterValues,
  type Activity,
  type ProjectViewPrefs,
  type SortDirection,
  type SortField,
  type ViewFilters,
  type ViewMode,
  type ViewPrefsFile,
} from '@shared/view-prefs-schema';
import { queryToViewFilters, viewFiltersToQuery } from '@shared/view-filters-query';
import { boardPreferenceScope, type BoardUrlState } from './boardUrlParams';

export interface EffectiveBoardFilters {
  view: ViewMode;
  status: string[];
  template: string[];
  priority: string[];
  assignee: string[];
  tags: string[];
  /** URL-only; never from prefs. */
  project: string[];
  activity: Activity;
  query: string;
  sortField: SortField;
  sortDirection: SortDirection;
}

export interface MergeBoardFiltersInput {
  url: BoardUrlState;
  prefsFile: ViewPrefsFile;
  /** When true, explicit URL `query` wins; otherwise synthesize from chips. */
  urlHasQuery: boolean;
}

function activityFromUrl(stale: Activity | null, prefsActivity: Activity): Activity {
  if (stale === 'stale' || stale === 'fresh') return stale;
  return prefsActivity;
}

/** Build effective filters once on bootstrap / URL navigation. */
export function mergeBoardFilters(input: MergeBoardFiltersInput): EffectiveBoardFilters {
  const scope = boardPreferenceScope(input.url.project);
  const prefs = mergeForScope(input.prefsFile, scope);

  const status = input.url.status.length > 0 ? input.url.status : toFilterValues(prefs.filters.status);
  const template =
    input.url.template.length > 0 ? input.url.template : toFilterValues(prefs.filters.template);
  const priority =
    input.url.priority.length > 0 ? input.url.priority : toFilterValues(prefs.filters.priority);
  const assignee =
    input.url.assignee.length > 0 ? input.url.assignee : toFilterValues(prefs.filters.assignee);
  const tags = input.url.tags.length > 0 ? input.url.tags : toFilterValues(prefs.filters.tags);
  const activity = activityFromUrl(input.url.stale, prefs.filters.activity ?? 'all');

  const view = input.url.view ?? prefs.defaultView;
  const sortField = input.url.sort ?? prefs.sortField;
  const sortDirection = input.url.dir ?? prefs.sortDirection;

  let query: string;
  if (input.urlHasQuery && input.url.query !== null) {
    query = input.url.query;
  } else {
    query = viewFiltersToQuery({
      status,
      priority,
      template,
      assignee,
      project: input.url.project,
      tags,
      activity: activity === 'fresh' || activity === 'stale' ? activity : 'all',
    });
  }

  return {
    view,
    status,
    template,
    priority,
    assignee,
    tags,
    project: input.url.project,
    activity,
    query,
    sortField,
    sortDirection,
  };
}

/** Patch to persist on user edit — never includes project filter. */
export function boardFiltersToPrefsPatch(
  filters: Pick<
    EffectiveBoardFilters,
    'view' | 'status' | 'template' | 'priority' | 'assignee' | 'tags' | 'activity' | 'sortField' | 'sortDirection'
  >,
): ProjectViewPrefs {
  return {
    defaultView: filters.view,
    sortField: filters.sortField,
    sortDirection: filters.sortDirection,
    filters: {
      status: filters.status,
      template: filters.template,
      priority: filters.priority,
      assignee: filters.assignee,
      tags: filters.tags,
      activity: filters.activity,
    },
  };
}

/** Deep-merge a prefs patch without touching the stored project filter. */
export function deepMergeViewPrefsPreservingProject(
  existing: ViewPrefsFile,
  scope: string | null,
  patch: ProjectViewPrefs,
): ViewPrefsFile {
  const scopeKey = scope;
  const next: ViewPrefsFile = {
    ...existing,
    global: { ...existing.global },
    projects: { ...existing.projects },
  };

  if (!scopeKey) {
    const prevFilters = existing.global.filters;
    next.global = {
      ...existing.global,
      ...patch,
      filters: {
        ...prevFilters,
        ...patch.filters,
        project: prevFilters.project,
      },
    };
    return next;
  }

  const prevScope = existing.projects[scopeKey] ?? {};
  const prevFilters = prevScope.filters ?? existing.global.filters;
  next.projects = {
    ...existing.projects,
    [scopeKey]: {
      ...prevScope,
      ...patch,
      filters: {
        ...prevFilters,
        ...patch.filters,
        project: prevFilters.project,
      },
    },
  };
  return next;
}

export function chipsFromQuery(query: string): ViewFilters | null {
  return queryToViewFilters(query);
}

export function queryFromChips(filters: ViewFilters): string {
  return viewFiltersToQuery(filters);
}

export function filterTicketsByProjectSlugs<T extends { projectSlug: string | null }>(
  items: readonly T[],
  slugs: readonly string[],
): T[] {
  if (slugs.length === 0) return [...items];
  const set = new Set(slugs);
  return items.filter((item) => item.projectSlug !== null && set.has(item.projectSlug));
}
