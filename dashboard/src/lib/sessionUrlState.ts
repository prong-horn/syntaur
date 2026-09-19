/**
 * Namespaced session-list URL state for `/sessions`.
 * Session filters are independent from usage filters (`usageUrlState.ts`).
 */
import {
  DEFAULT_ARCHIVED_FILTER,
  type ArchivedFilter,
  ARCHIVED_FILTERS,
} from '@shared/session-archived';
import {
  DEFAULT_SESSION_ATTRIBUTION,
  SESSION_ATTRIBUTIONS,
  type SessionAttribution,
} from '@shared/session-attribution';
import { DEFAULT_SESSION_SORT, SESSION_SORTS, type SessionSort } from '@shared/session-sort';
import type { SessionsQuery } from '../data/resources';

export const SESSION_PAGE_SIZE_OPTIONS = [50, 100, 250, 500] as const;
export const DEFAULT_SESSION_PAGE_SIZE = 100;

export interface SessionUrlState {
  page: number;
  pageSize: number;
  search: string;
  startedFrom: string;
  startedTo: string;
  sort: SessionSort;
  attribution: SessionAttribution;
  archived: ArchivedFilter;
  /** Open session detail drawer. */
  sessionId?: string;
  /** `usage` opens the embedded usage rollup section. */
  panel?: 'usage';
}

export const DEFAULT_SESSION_URL_STATE: SessionUrlState = {
  page: 0,
  pageSize: DEFAULT_SESSION_PAGE_SIZE,
  search: '',
  startedFrom: '',
  startedTo: '',
  sort: DEFAULT_SESSION_SORT,
  attribution: DEFAULT_SESSION_ATTRIBUTION,
  archived: DEFAULT_ARCHIVED_FILTER,
};

function parseIntParam(value: string | null, fallback: number, min = 0): number {
  if (value === null || value === '') return fallback;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n >= min ? n : fallback;
}

function parseEnum<T extends string>(value: string | null, allowed: readonly T[], fallback: T): T {
  if (value && (allowed as readonly string[]).includes(value)) return value as T;
  return fallback;
}

function parsePageSize(value: string | null): number {
  const n = parseIntParam(value, DEFAULT_SESSION_PAGE_SIZE, 1);
  return (SESSION_PAGE_SIZE_OPTIONS as readonly number[]).includes(n) ? n : DEFAULT_SESSION_PAGE_SIZE;
}

/** Read session state from the full page query string (ignores usage keys). */
export function parseSessionUrlState(sp: URLSearchParams): SessionUrlState {
  const panel = sp.get('panel');
  const sessionId = sp.get('session')?.trim();
  return {
    page: parseIntParam(sp.get('sessionPage'), 0),
    pageSize: parsePageSize(sp.get('sessionPageSize')),
    search: sp.get('sessionSearch') ?? '',
    startedFrom: sp.get('sessionStartedFrom') ?? '',
    startedTo: sp.get('sessionStartedTo') ?? '',
    sort: parseEnum(sp.get('sessionSort'), SESSION_SORTS, DEFAULT_SESSION_SORT),
    attribution: parseEnum(sp.get('sessionAttribution'), SESSION_ATTRIBUTIONS, DEFAULT_SESSION_ATTRIBUTION),
    archived: parseEnum(sp.get('sessionArchived'), ARCHIVED_FILTERS, DEFAULT_ARCHIVED_FILTER),
    sessionId: sessionId || undefined,
    panel: panel === 'usage' ? 'usage' : undefined,
  };
}

/** Keys owned by the session list (not usage). */
export const SESSION_URL_KEYS = [
  'sessionPage',
  'sessionPageSize',
  'sessionSearch',
  'sessionStartedFrom',
  'sessionStartedTo',
  'sessionSort',
  'sessionAttribution',
  'sessionArchived',
  'session',
  'panel',
] as const;

/**
 * Merge session fields into existing params, preserving unrelated keys (usage).
 * Omits keys at default values except `panel` and `session` when absent.
 */
export function serializeSessionUrlState(
  state: SessionUrlState,
  base: URLSearchParams = new URLSearchParams(),
): URLSearchParams {
  const out = new URLSearchParams(base.toString());
  for (const key of SESSION_URL_KEYS) out.delete(key);

  if (state.page > 0) out.set('sessionPage', String(state.page));
  if (state.pageSize !== DEFAULT_SESSION_PAGE_SIZE) out.set('sessionPageSize', String(state.pageSize));
  if (state.search.trim()) out.set('sessionSearch', state.search.trim());
  if (state.startedFrom) out.set('sessionStartedFrom', state.startedFrom);
  if (state.startedTo) out.set('sessionStartedTo', state.startedTo);
  if (state.sort !== DEFAULT_SESSION_SORT) out.set('sessionSort', state.sort);
  if (state.attribution !== DEFAULT_SESSION_ATTRIBUTION) out.set('sessionAttribution', state.attribution);
  if (state.archived !== DEFAULT_ARCHIVED_FILTER) out.set('sessionArchived', state.archived);
  if (state.sessionId) out.set('session', state.sessionId);
  if (state.panel === 'usage') out.set('panel', 'usage');
  return out;
}

/** Map URL state to the sessions list API query (debounced search applied by caller). */
export function sessionUrlToQuery(state: SessionUrlState, debouncedSearch?: string): SessionsQuery {
  const search = (debouncedSearch ?? state.search).trim();
  return {
    page: state.page,
    pageSize: state.pageSize,
    search: search || undefined,
    startedFrom: state.startedFrom || undefined,
    startedTo: state.startedTo || undefined,
    sort: state.sort,
    attribution: state.attribution,
    archived: state.archived,
  };
}

/** Filter fields that reset pagination when changed. */
export const SESSION_FILTER_KEYS: ReadonlyArray<keyof SessionUrlState> = [
  'search',
  'startedFrom',
  'startedTo',
  'sort',
  'attribution',
  'archived',
  'pageSize',
];

export function sessionFiltersEqual(a: SessionUrlState, b: SessionUrlState): boolean {
  return (
    a.search === b.search
    && a.startedFrom === b.startedFrom
    && a.startedTo === b.startedTo
    && a.sort === b.sort
    && a.attribution === b.attribution
    && a.archived === b.archived
    && a.pageSize === b.pageSize
  );
}

/**
 * Apply a session filter patch; resets `page` to 0 when a list-shaping field changes.
 * Does not touch usage keys on `base`.
 */
export function patchSessionUrlState(
  current: SessionUrlState,
  patch: Partial<SessionUrlState>,
  base: URLSearchParams,
): URLSearchParams {
  const next: SessionUrlState = { ...current, ...patch };
  const filtersChanged =
    patch.page === undefined
    && SESSION_FILTER_KEYS.some((key) => key in patch && patch[key] !== current[key]);
  if (filtersChanged) next.page = 0;
  return serializeSessionUrlState(next, base);
}
