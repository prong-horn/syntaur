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

/**
 * The four v1 "needs me" categories. A closed union — predicates and ordering
 * live in the pure aggregation module so they unit-test without a server.
 *
 * - `review`        — derived `status === 'review'` (awaiting accept/reopen)
 * - `blocked`       — derived `status === 'blocked'` (awaiting unblock)
 * - `question`      — an unresolved `question` comment (awaiting an answer)
 * - `plan-approval` — `ready_for_planning` with a latest, unapproved plan
 */
export type InboxCategory = 'review' | 'blocked' | 'question' | 'plan-approval';

/** All categories in canonical render order. */
export const INBOX_CATEGORIES: readonly InboxCategory[] = [
  'review',
  'blocked',
  'question',
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
 * One assignment item awaiting human action. `since`/`ageMs` live on every item
 * so the field set stays reusable by a later staleness watchdog.
 */
export interface InboxItem {
  /** Owning project slug; `null` for standalone assignments. */
  project: string | null;
  /** Assignment slug; for standalone, the UUID folder name. */
  assignmentSlug: string;
  /** Assignment id (UUID from frontmatter). */
  assignmentId: string;
  title: string;
  category: InboxCategory;
  /** RFC 3339 timestamp — when the item entered its awaiting-human state. */
  since: string;
  /** `max(0, now − since)` in milliseconds. */
  ageMs: number;
  /** One-line context line. */
  summary: string;
  action: InboxAction;
  /**
   * Review-only: the derived CLI verb that ACCEPTS the review (terminal target),
   * or `null` when none qualifies. Carried structurally so the dashboard POSTs
   * `transitions/<acceptCommand>` without re-parsing `action.command`.
   */
  acceptCommand?: string | null;
  /**
   * Review-only: the derived CLI verb that REOPENS the review (active target),
   * or `null` when none qualifies.
   */
  reopenCommand?: string | null;
  /** Question-only: the unresolved comment's id (for reply `replyTo` + resolve). */
  commentId?: string;
}

/**
 * The aggregation result. `counts`/`total` reflect the FULL matched set (after
 * `project`/`types` filtering); `items` is the same set ordered most-urgent
 * first within each category, then truncated by `limit`.
 */
export interface InboxResult {
  items: InboxItem[];
  counts: Record<InboxCategory, number>;
  total: number;
}
