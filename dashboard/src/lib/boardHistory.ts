/**
 * Board terminal-history filtering (URL-only `history` / `olderThanDays`).
 * Age is computed from `completedAt` for the current terminal entry; missing or
 * invalid dates stay visible in `recent` and are excluded from `older`.
 */
import { isTerminalStatus } from './statusMeta';

export type HistoryMode = 'recent' | 'all' | 'older';

export const HISTORY_MODES: readonly HistoryMode[] = ['recent', 'all', 'older'];

const MS_PER_DAY = 86_400_000;

export const DEFAULT_OLDER_THAN_DAYS = 30;
export const MIN_OLDER_THAN_DAYS = 1;
export const MAX_OLDER_THAN_DAYS = 36_500;

export interface HistoryFilterable {
  status: string;
  completedAt: string | null;
}

export function normalizeHistoryMode(value: string | null | undefined): HistoryMode {
  if (value === 'all' || value === 'older') return value;
  return 'recent';
}

/** Invalid or absent values normalize to {@link DEFAULT_OLDER_THAN_DAYS}. */
export function normalizeOlderThanDays(value: string | null | undefined): number {
  if (value === null || value === undefined || value === '') return DEFAULT_OLDER_THAN_DAYS;
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n < MIN_OLDER_THAN_DAYS || n > MAX_OLDER_THAN_DAYS) {
    return DEFAULT_OLDER_THAN_DAYS;
  }
  return n;
}

export function isBoardTerminal(status: string): boolean {
  return status === 'done' || status === 'dropped' || isTerminalStatus({ id: status });
}

function completionAgeDays(completedAt: string | null, now: Date): number | null {
  if (!completedAt) return null;
  const parsed = new Date(completedAt);
  if (Number.isNaN(parsed.getTime())) return null;
  return (now.getTime() - parsed.getTime()) / MS_PER_DAY;
}

/**
 * Filter board tickets by history mode. Non-terminal tickets are always shown in
 * `recent` and `all`, never in `older`. At exactly the cutoff day the ticket is
 * NOT considered older (`age > olderThanDays` required for `older`).
 */
export function filterByHistoryMode<T extends HistoryFilterable>(
  items: readonly T[],
  mode: HistoryMode,
  olderThanDays: number,
  now: Date = new Date(),
): T[] {
  if (mode === 'all') return [...items];

  return items.filter((item) => {
    if (!isBoardTerminal(item.status)) {
      return mode === 'recent';
    }

    const age = completionAgeDays(item.completedAt, now);
    if (age === null) {
      return mode === 'recent';
    }

    if (mode === 'recent') {
      return age <= olderThanDays;
    }

    // older: terminal only, strictly past the cutoff
    return age > olderThanDays;
  });
}
