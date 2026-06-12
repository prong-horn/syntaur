/**
 * Shared usage-widget filter logic — window math, validation, URL
 * serialization, and labels. Lives in `src/utils/` so it is (a) unit-tested by
 * the root Vitest suite and (b) importable by the dashboard via
 * `@shared/usage-filters`. This is the SINGLE source of truth for how a
 * Token Usage / Spend widget's filters map to a `/api/usage` query, so the
 * widget display, the API query, the filter summary, the config dialog, and the
 * `/usage` page can never disagree.
 *
 * All window math is in UTC: `usage_daily.day` is a UTC `YYYY-MM-DD`, and the
 * event-bound expansion in `api-usage.ts` uses `…T23:59:59.999Z` — so presets
 * are computed against the UTC calendar to avoid off-by-one days.
 */

export type UsageWindow = '7d' | '30d' | '90d' | 'all' | 'custom';

export const USAGE_WINDOWS: readonly UsageWindow[] = ['7d', '30d', '90d', 'all', 'custom'] as const;

/** Window applied when a widget has no saved `window`. */
export const DEFAULT_WINDOW: UsageWindow = '30d';

export interface UsageWidgetFilters {
  /** Preset/custom time window. Defaults to {@link DEFAULT_WINDOW} at query time. */
  window?: UsageWindow;
  /** `YYYY-MM-DD`. Only meaningful when `window === 'custom'`. */
  since?: string;
  /** `YYYY-MM-DD`. Only meaningful when `window === 'custom'`. */
  until?: string;
  project?: string;
  workspace?: string;
  model?: string;
  tool?: string;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const STRING_FIELDS = ['project', 'workspace', 'model', 'tool'] as const;
const WINDOW_DAYS: Record<'7d' | '30d' | '90d', number> = { '7d': 7, '30d': 30, '90d': 90 };

/** True only for a real `YYYY-MM-DD` calendar date (rejects e.g. `2026-13-40`). */
export function isValidDateString(value: unknown): value is string {
  if (typeof value !== 'string' || !DATE_RE.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function toUtcDay(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function addUtcDays(date: Date, days: number): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + days));
}

/**
 * Resolve a filter set's window to concrete `since`/`until` day bounds (UTC).
 * - `7d`/`30d`/`90d` → exactly N inclusive days ending today: `30d` = `today−29 … today`.
 * - `all` → `{}` (no bounds).
 * - `custom` → pass through `since`/`until`; a missing bound stays open-ended,
 *   and both missing behaves like `all`.
 */
export function resolveWindow(
  filters: UsageWidgetFilters,
  now: Date = new Date(),
): { since?: string; until?: string } {
  const window = filters.window ?? DEFAULT_WINDOW;
  if (window === 'all') return {};
  if (window === 'custom') {
    const out: { since?: string; until?: string } = {};
    if (filters.since) out.since = filters.since;
    if (filters.until) out.until = filters.until;
    return out;
  }
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  return {
    since: toUtcDay(addUtcDays(today, -(WINDOW_DAYS[window] - 1))),
    until: toUtcDay(today),
  };
}

export interface FilterValidation {
  ok: boolean;
  errors: string[];
}

/**
 * Validate a raw filter object. Known fields are type/format-checked; unknown
 * keys are ignored (forward-compat). `null` field values and arrays fail.
 */
export function validateFilters(raw: unknown): FilterValidation {
  const errors: string[] = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, errors: ['filters must be an object'] };
  }
  const obj = raw as Record<string, unknown>;
  if (obj.window !== undefined && !(USAGE_WINDOWS as readonly unknown[]).includes(obj.window)) {
    errors.push(`invalid window: ${String(obj.window)}`);
  }
  for (const key of ['since', 'until'] as const) {
    if (obj[key] !== undefined && !isValidDateString(obj[key])) {
      errors.push(`invalid ${key}: ${String(obj[key])} (expected YYYY-MM-DD)`);
    }
  }
  for (const key of STRING_FIELDS) {
    if (obj[key] !== undefined && (typeof obj[key] !== 'string' || (obj[key] as string).length === 0)) {
      errors.push(`invalid ${key}: must be a non-empty string`);
    }
  }
  if (isValidDateString(obj.since) && isValidDateString(obj.until) && obj.since > obj.until) {
    errors.push('since must be on or before until');
  }
  return { ok: errors.length === 0, errors };
}

/** Structural guard reused by `isWidgetConfig` for the usage widget kinds. */
export function isUsageWidgetFilters(value: unknown): boolean {
  return validateFilters(value).ok;
}

/**
 * Coerce a raw value into a clean {@link UsageWidgetFilters}: drop empty
 * strings, drop unknown keys, drop invalid values, and strip custom dates
 * unless `window === 'custom'`. Used before persisting and before querying.
 */
export function normalizeFilters(raw: unknown): UsageWidgetFilters {
  const out: UsageWidgetFilters = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.window === 'string' && (USAGE_WINDOWS as readonly string[]).includes(obj.window)) {
    out.window = obj.window as UsageWindow;
  }
  if (isValidDateString(obj.since)) out.since = obj.since;
  if (isValidDateString(obj.until)) out.until = obj.until;
  for (const key of STRING_FIELDS) {
    if (typeof obj[key] === 'string' && (obj[key] as string).length > 0) out[key] = obj[key] as string;
  }
  // Custom dates are only meaningful for the custom window — drop them otherwise
  // so a preset window doesn't carry stale bounds in its persisted config.
  if (out.window !== 'custom') {
    delete out.since;
    delete out.until;
  }
  return out;
}

/** Serialize filters to URL query params (round-trips with {@link parseFilters}). */
export function serializeFilters(filters: UsageWidgetFilters): URLSearchParams {
  const f = normalizeFilters(filters);
  const sp = new URLSearchParams();
  if (f.window) sp.set('window', f.window);
  if (f.window === 'custom') {
    if (f.since) sp.set('since', f.since);
    if (f.until) sp.set('until', f.until);
  }
  for (const key of STRING_FIELDS) {
    if (f[key]) sp.set(key, f[key] as string);
  }
  return sp;
}

/** Parse filters back out of URL query params. */
export function parseFilters(sp: URLSearchParams): UsageWidgetFilters {
  const raw: Record<string, unknown> = {};
  for (const key of ['window', 'since', 'until', ...STRING_FIELDS] as const) {
    const v = sp.get(key);
    if (v !== null) raw[key] = v;
  }
  return normalizeFilters(raw);
}

/**
 * Build the concrete `GET /api/usage` query params for a filter set — resolves
 * the window to `since`/`until` (the API takes dates, not a `window` token) and
 * forwards `project`/`workspace`/`model`/`tool`. Shared by the widget data hook
 * and the `/usage` page so both query the API identically.
 */
export function buildUsageApiQuery(filters: UsageWidgetFilters, now: Date = new Date()): URLSearchParams {
  const f = normalizeFilters(filters);
  const { since, until } = resolveWindow(f, now);
  const sp = new URLSearchParams();
  if (since) sp.set('since', since);
  if (until) sp.set('until', until);
  for (const key of STRING_FIELDS) {
    if (f[key]) sp.set(key, f[key] as string);
  }
  return sp;
}

const WINDOW_LABEL: Record<UsageWindow, string> = {
  '7d': 'Last 7 days',
  '30d': 'Last 30 days',
  '90d': 'Last 90 days',
  all: 'All time',
  custom: 'Custom range',
};

/** Human-readable summary, e.g. `"Last 30 days · project: syntaur-meta"`. */
export function filterSummaryLabel(filters: UsageWidgetFilters): string {
  const f = normalizeFilters(filters);
  const window = f.window ?? DEFAULT_WINDOW;
  const parts: string[] = [];
  parts.push(window === 'custom' ? `${f.since ?? '…'} → ${f.until ?? '…'}` : WINDOW_LABEL[window]);
  if (f.workspace) parts.push(`workspace: ${f.workspace}`);
  if (f.project) parts.push(`project: ${f.project}`);
  if (f.model) parts.push(`model: ${f.model}`);
  if (f.tool) parts.push(`tool: ${f.tool}`);
  return parts.join(' · ');
}
