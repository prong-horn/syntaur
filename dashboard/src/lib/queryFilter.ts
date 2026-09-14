/**
 * AQL-based board filtering for the dashboard.
 *
 * Pure — no React imports. Node-testable. The archived-exclude logic lives
 * OUTSIDE the compiled query so it stays a page option, not part of the AQL
 * expression.
 */

import type { TicketBoardItem } from '../hooks/useProjects';
import type { CompiledQuery, EvalContext, QueryItem } from '@shared/query';

// ── boardItemToQueryItem ──────────────────────────────────────────────────────

/**
 * Adapt a board item to the flat QueryItem record the AQL engine evaluates
 * against. Mirrors `ls.ts loadQueryItem` field set (lines 166-183):
 *   spread facts FIRST (camelCase keys); then explicit built-ins by their
 *   camelCase canonical keys (the engine's `readField` falls back to item[fieldName]
 *   when no `get` accessor is present, and accessors handle the lowercased→camelCase
 *   mapping for built-ins like `completedAt`/`statusAge`/`phaseAge`).
 *
 * `searchText` is the dashboard haystack: title + slug + projectTitle + projectSlug,
 * matching the existing `filterTicket` search logic at ticketFilter.ts:153.
 * The `search` field in the registry reads `item['searchText'] ?? item['title']`
 * so populating `searchText` on the item is sufficient.
 */
export function boardItemToQueryItem(item: TicketBoardItem): QueryItem {
  // Build search haystack exactly as ticketFilter.ts:153 does:
  //   `${item.title ?? ''} ${item.slug ?? ''} ${item.projectTitle ?? 'standalone'} ${item.projectSlug ?? ''}`
  const searchText = `${item.title ?? ''} ${item.slug ?? ''} ${item.projectTitle ?? 'standalone'} ${item.projectSlug ?? ''}`;

  return {
    // ── core frontmatter fields ──────────────────────────────────────────────
    status: item.status,
    phase: item.status,
    disposition: item.blocked ? 'blocked' : item.parked ? 'parked' : 'active',
    blocked: Boolean(item.blocked),
    parked: Boolean(item.parked),
    priority: item.priority,
    template: item.template,
    assignee: item.assignee,
    project: item.projectSlug,
    tags: item.tags,
    title: item.title,
    created: item.created,
    updated: item.updated,

    // ── history virtuals ──────────────────────────────────────────────────────
    completedAt: item.completedAt,
    statusAge: item.statusAge,

    // ── search haystack ───────────────────────────────────────────────────────
    // `search` field in fields.ts: `get: (i) => i['searchText'] ?? i['title']`
    searchText,
  };
}

// ── FilterBoardItemsOptions ───────────────────────────────────────────────────

export interface FilterBoardItemsOptions {
  /** When true, archived items are included; otherwise they are excluded before AQL runs. */
  includeArchived?: boolean;
  /**
   * Epoch ms for resolving relative duration literals (e.g. `completedAt < -1mo`).
   * Defaults to `Date.now()` at call time — override for deterministic tests.
   */
  now?: number;
}

// ── filterBoardItems ──────────────────────────────────────────────────────────

/**
 * Apply archived-exclude pre-filters (page options), then evaluate the compiled
 * AQL predicate against each remaining item.
 *
 * The pre-filter logic mirrors `ticketFilter.ts` exactly:
 *   - archived excluded by default unless `includeArchived` is true.
 *
 * `now` is threaded into `EvalContext` so timestamp/duration predicates
 * (e.g. `completedAt < -1mo`, `statusAge > 3d`) resolve deterministically.
 * Only defaulted to `Date.now()` at the call boundary — never inside the engine.
 *
 * When `compiled` is `null` (empty / invalid query), the AQL constraint is
 * skipped entirely — only the page-level archived-exclude pre-filter is applied.
 * This is the "match-all" path: a typo never blanks the board, but archived
 * scoping still holds.
 */
export function filterBoardItems(
  items: TicketBoardItem[],
  compiled: CompiledQuery | null,
  opts: FilterBoardItemsOptions = {},
): TicketBoardItem[] {
  const { now = Date.now() } = opts;

  const ctx: EvalContext = { now };

  return items.filter((item) => {
    // ── page-level pre-filters (NOT part of AQL) ──────────────────────────
    if (item.parked && !opts.includeArchived) return false;
    // ── AQL predicate (skipped when compiled is null → pre-filters only) ──
    if (!compiled) return true;
    const q = boardItemToQueryItem(item);
    return compiled.predicate(q, ctx);
  });
}
