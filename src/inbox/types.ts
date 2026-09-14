/**
 * Shared inbox types — the contract between the pure aggregation core
 * (`src/inbox/index.ts`), the `syntaur inbox` CLI (`src/commands/inbox.ts`), and
 * the dashboard router (`src/dashboard/api-inbox.ts`). Mirrors the `src/search/`
 * module layout (pure core + typed result).
 *
 * See the "Decision Inbox" plan (Category Inventory + Action Resolution) and
 * decision-record #1 (InboxItem shape) for the authoritative spec — these types
 * are the single source of truth other tasks import.
 */

import type { ChatQuestionKind } from '../chat/types.js';

/**
 * Parsed chat marker on a question comment.
 */
export interface InboxChatRef {
  kind: ChatQuestionKind;
  itemId: string;
  turnId?: string;
  agentId: string;
}

/** Card metadata enriched by the core via `lookupChatItem` for inline inbox actions. */
export type InboxCard =
  | {
      requestId: string;
      kind: 'permission';
      options: Array<{ optionId: string; name: string; kind: string }>;
      settled: boolean;
    }
  | {
      requestId: string;
      kind: 'ask';
      options: Array<{ id: string; label: string }> | null;
      settled: boolean;
    };

/**
 * The three v1 "needs me" categories. A closed union — predicates and ordering
 * live in the pure aggregation module so they unit-test without a server.
 *
 * - `question`      — an unresolved `question` comment (awaiting an answer)
 * - `review`        — derived `status === 'review'` (awaiting accept/reopen)
 * - `plan-approval` — `ready_for_planning` with a latest, unapproved plan
 */
export type InboxCategory = 'question' | 'review' | 'plan-approval';

/** All categories in canonical render order (CLI grouping). */
export const INBOX_CATEGORIES: readonly InboxCategory[] = [
  'question',
  'review',
  'plan-approval',
];

/**
 * The inline quick-action descriptor (decision-record #1, revised).
 * `verb` is the human label (e.g. "Accept"/"Unblock"/"Answer"/"Approve plan");
 * `command` is the EXACT CLI string (the AC4 contract — the one place exact
 * strings matter). The CLI prints `command`; the dashboard derives its endpoint
 * locally from `(project, slug|id, category)`.
 */
export interface InboxAction {
  verb: string;
  command: string;
}

/**
 * One ticket item awaiting human action. `since`/`ageMs` live on every item
 * so the field set stays reusable by a later staleness watchdog.
 */
export interface InboxItem {
  /** Owning project slug; `null` for standalone tickets. */
  project: string | null;
  /** Ticket slug; for standalone, the UUID folder name. */
  ticketSlug: string;
  /** Ticket id (UUID from frontmatter). */
  ticketId: string;
  title: string;
  category: InboxCategory;
  /** RFC 3339 timestamp — when the item entered its awaiting-human state. */
  since: string;
  /** `max(0, now − since)` in milliseconds. */
  ageMs: number;
  /** One-line context line (clipped for CLI). */
  summary: string;
  /** Question-only: marker-stripped full text (dashboard body). */
  body?: string;
  action: InboxAction;
  /**
   * Review-only: the derived CLI verb that ACCEPTS the review (terminal target),
   * or `null` when none qualifies. Carried structurally so the dashboard POSTs
   * `verbs/<acceptCommand>` without re-parsing `action.command`.
   */
  acceptCommand?: string | null;
  /**
   * Review-only: the derived CLI verb that REOPENS the review (active target),
   * or `null` when none qualifies.
   */
  reopenCommand?: string | null;
  /** Review-only: gate hint to log an approving review when not yet clean. */
  logReviewHint?: string;
  /** Question-only: the unresolved comment's id (for reply `replyTo` + resolve). */
  commentId?: string;
  /** Question-only: chat-sourced row linking to a chat item. */
  chat?: InboxChatRef;
  /** Permission/ask chat rows: card options from the chat index (API-enriched). */
  card?: InboxCard | null;
  /** Frontmatter `updated` (may be `''` when absent). Used for snooze fingerprints. */
  ticketUpdated: string;
  /** Present when `includeSnoozed` is set and the row is snoozed. */
  snoozed?: { until: string | null };
}

/** One snooze entry in `inbox-snoozes.json`. */
export interface SnoozeEntry {
  until: string | null;
  fingerprint: string;
  createdAt: string;
}

export type SnoozeMap = Record<string, SnoozeEntry>;

/**
 * Urgency tier for inbox ordering (ascending = more urgent).
 * 0 — live permission/ask cards; 1 — chat replies; 2 — plain questions or settled cards;
 * 3 — plan approvals; 4 — reviews.
 */
export type InboxTier = 0 | 1 | 2 | 3 | 4;

/**
 * The aggregation result. `counts`/`total` reflect the FULL matched set (after
 * `project`/`types` filtering); `items` is the same set ordered by tier, then
 * oldest-first within each tier, then truncated by `limit`.
 */
export interface InboxResult {
  items: InboxItem[];
  counts: Record<InboxCategory, number>;
  total: number;
  /** Rows hidden by an active snooze (excluded from counts/total). */
  snoozedCount: number;
  /** Snooze keys lifted because the row fingerprint changed (`until: null`). */
  liftedSnoozeKeys: string[];
}
