/**
 * AQL-based board filtering for the dashboard.
 *
 * Pure — no React imports. Node-testable. The workspace / _ungrouped /
 * archived-exclude logic lives OUTSIDE the compiled query so it stays a page
 * option, not part of the AQL expression.
 */

import type { AssignmentBoardItem } from '../hooks/useProjects';
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
 * matching the existing `filterAssignment` search logic at assignmentFilter.ts:153.
 * The `search` field in the registry reads `item['searchText'] ?? item['title']`
 * so populating `searchText` on the item is sufficient.
 */
export function boardItemToQueryItem(item: AssignmentBoardItem): QueryItem {
  // Build search haystack exactly as assignmentFilter.ts:153 does:
  //   `${item.title ?? ''} ${item.slug ?? ''} ${item.projectTitle ?? 'standalone'} ${item.projectSlug ?? ''}`
  const searchText = `${item.title ?? ''} ${item.slug ?? ''} ${item.projectTitle ?? 'standalone'} ${item.projectSlug ?? ''}`;

  return {
    // Custom facts first (camelCase keys: the registry accessors map them from
    // lowercase registry keys via their `get` functions, e.g. `i['hasRealObjective']`).
    ...(item.facts ?? {}),

    // ── core frontmatter fields ──────────────────────────────────────────────
    status: item.status,
    phase: item.phase,
    disposition: item.disposition,
    priority: item.priority,
    type: item.type,
    assignee: item.assignee,
    project: item.projectSlug,
    tags: item.tags,
    archived: item.archived,
    title: item.title,
    created: item.created,
    updated: item.updated,

    // ── history virtuals ──────────────────────────────────────────────────────
    // These use camelCase keys; the registry's `get` accessors read them by
    // that exact name (e.g. `i['completedAt']`, `i['statusAge']`, `i['phaseAge']`).
    completedAt: item.completedAt,
    statusAge: item.statusAge,
    phaseAge: item.phaseAge,

    // ── search haystack ───────────────────────────────────────────────────────
    // `search` field in fields.ts: `get: (i) => i['searchText'] ?? i['title']`
    searchText,
  };
}

// ── FilterBoardItemsOptions ───────────────────────────────────────────────────

export interface FilterBoardItemsOptions {
  /** When set, only items matching this workspace (or `_ungrouped` for null workspace) pass. */
  workspace?: string | null;
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
 * Apply workspace / _ungrouped / archived-exclude pre-filters (page options),
 * then evaluate the compiled AQL predicate against each remaining item.
 *
 * The pre-filter logic mirrors `assignmentFilter.ts:109-127` exactly:
 *   - archived excluded by default unless `includeArchived` is true.
 *   - workspace='_ungrouped' keeps items with `projectWorkspace === null`.
 *   - workspace=<other> keeps items where `projectWorkspace === workspace`.
 *
 * `now` is threaded into `EvalContext` so timestamp/duration predicates
 * (e.g. `completedAt < -1mo`, `statusAge > 3d`) resolve deterministically.
 * Only defaulted to `Date.now()` at the call boundary — never inside the engine.
 */
export function filterBoardItems(
  items: AssignmentBoardItem[],
  compiled: CompiledQuery,
  opts: FilterBoardItemsOptions = {},
): AssignmentBoardItem[] {
  const { workspace, includeArchived = false, now = Date.now() } = opts;

  const ctx: EvalContext = { now };

  return items.filter((item) => {
    // ── page-level pre-filters (NOT part of AQL) ──────────────────────────
    if (item.archived === true && !includeArchived) return false;

    if (workspace) {
      if (workspace === '_ungrouped') {
        if (item.projectWorkspace != null) return false;
      } else if (item.projectWorkspace !== workspace) {
        return false;
      }
    }

    // ── AQL predicate ──────────────────────────────────────────────────────
    const q = boardItemToQueryItem(item);
    return compiled.predicate(q, ctx);
  });
}
