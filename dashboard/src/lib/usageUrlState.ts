/**
 * Namespaced usage URL state for the Sessions page usage panel.
 * Adapts the shared `usage-filters` helpers without changing their key names.
 */
import {
  DEFAULT_WINDOW,
  USAGE_WINDOWS,
  normalizeFilters,
  parseFilters,
  serializeFilters,
  type UsageWidgetFilters,
  type UsageWindow,
} from '@shared/usage-filters';

export type UsageGroupBy = 'project' | 'ticket';

export interface UsageUrlState {
  filters: UsageWidgetFilters;
  groupBy: UsageGroupBy;
}

export const DEFAULT_USAGE_URL_STATE: UsageUrlState = {
  filters: { window: DEFAULT_WINDOW },
  groupBy: 'project',
};

/** Namespaced query keys owned by the usage panel. */
export const USAGE_URL_KEYS = [
  'usageWindow',
  'usageSince',
  'usageUntil',
  'usageProject',
  'usageModel',
  'usageTool',
  'usageGroupBy',
] as const;

/** Legacy `/usage` keys mapped by `legacyRoutes` into namespaced form. */
export const LEGACY_USAGE_URL_KEYS = ['window', 'since', 'until', 'project', 'model', 'tool', 'groupBy'] as const;

const LEGACY_TO_NAMESPACED: Record<string, string> = {
  window: 'usageWindow',
  since: 'usageSince',
  until: 'usageUntil',
  project: 'usageProject',
  model: 'usageModel',
  tool: 'usageTool',
  groupBy: 'usageGroupBy',
};

const NAMESPACED_TO_LEGACY: Record<string, string> = Object.fromEntries(
  Object.entries(LEGACY_TO_NAMESPACED).map(([legacy, namespaced]) => [namespaced, legacy]),
);

function parseGroupBy(value: string | null): UsageGroupBy {
  return value === 'ticket' ? 'ticket' : 'project';
}

/** Read usage state from namespaced keys on a full page query string. */
export function parseUsageUrlState(sp: URLSearchParams): UsageUrlState {
  const raw: Record<string, string> = {};
  const window = sp.get('usageWindow');
  if (window) raw.window = window;
  const since = sp.get('usageSince');
  if (since) raw.since = since;
  const until = sp.get('usageUntil');
  if (until) raw.until = until;
  const project = sp.get('usageProject');
  if (project) raw.project = project;
  const model = sp.get('usageModel');
  if (model) raw.model = model;
  const tool = sp.get('usageTool');
  if (tool) raw.tool = tool;
  const filters = normalizeFilters(raw);
  if (!filters.window) filters.window = DEFAULT_WINDOW;
  return {
    filters,
    groupBy: parseGroupBy(sp.get('usageGroupBy')),
  };
}

/** Serialize usage state to namespaced keys, preserving unrelated params. */
export function serializeUsageUrlState(
  state: UsageUrlState,
  base: URLSearchParams = new URLSearchParams(),
): URLSearchParams {
  const out = new URLSearchParams(base.toString());
  for (const key of USAGE_URL_KEYS) out.delete(key);
  for (const key of LEGACY_USAGE_URL_KEYS) out.delete(key);

  const legacy = serializeFilters(state.filters);
  for (const [key, value] of legacy.entries()) {
    const namespaced = LEGACY_TO_NAMESPACED[key];
    if (namespaced) out.set(namespaced, value);
  }
  if (state.groupBy === 'ticket') out.set('usageGroupBy', 'ticket');
  return out;
}

/** Translate legacy `/usage?window=…` params into namespaced keys (for legacyRoutes). */
export function legacyUsageSearchParams(sp: URLSearchParams): URLSearchParams {
  const out = new URLSearchParams(sp.toString());
  for (const [legacy, namespaced] of Object.entries(LEGACY_TO_NAMESPACED)) {
    const value = out.get(legacy);
    if (value !== null) {
      out.delete(legacy);
      out.set(namespaced, value);
    }
  }
  return out;
}

/** Translate namespaced usage keys back to legacy form (for tests / deep links). */
export function namespacedUsageToLegacy(sp: URLSearchParams): URLSearchParams {
  const out = new URLSearchParams(sp.toString());
  for (const [namespaced, legacy] of Object.entries(NAMESPACED_TO_LEGACY)) {
    const value = out.get(namespaced);
    if (value !== null) {
      out.delete(namespaced);
      out.set(legacy, value);
    }
  }
  return out;
}

/** Parse legacy usage keys directly (old UsagePage behaviour). */
export function parseLegacyUsageUrlState(sp: URLSearchParams): UsageUrlState {
  const filters = parseFilters(sp);
  if (!filters.window) filters.window = DEFAULT_WINDOW;
  return {
    filters,
    groupBy: parseGroupBy(sp.get('groupBy')),
  };
}

export function isValidUsageWindow(value: string | null): value is UsageWindow {
  return value !== null && (USAGE_WINDOWS as readonly string[]).includes(value);
}
