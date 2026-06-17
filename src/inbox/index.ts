/**
 * Pure aggregation core for the "Needs me" decision inbox.
 *
 * `computeInbox` does ONE O(n) directory scan via `listAssignmentsByProject`,
 * then for each entry does ONE read+parse of `assignment.md` (via the full
 * parser) and — only when `comments.md` exists — ONE read → `parseComments`.
 * Every predicate, the `since` fallback chain, the accept-verb derivation, and
 * ordering are PURE EXPORTED functions so they unit-test without a server. The
 * core NEVER resolves config/dirs itself — callers pass them in.
 *
 * See the "Decision Inbox" plan (Category Inventory + Action Resolution) and the
 * decision-record. Predicates are derived-status based (parity with the
 * dashboard NeedsAttention derivation). `archived === true` entries are skipped
 * up front.
 */

import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileExists } from '../utils/fs.js';
import { listAssignmentsByProject } from '../utils/assignment-walk.js';
import {
  parseAssignmentFull,
  parseComments,
  type ParsedAssignmentFull,
  type ParsedComment,
} from '../dashboard/parser.js';
import { latestPlanFile, isPlanApproved } from '../lifecycle/facts.js';
import { getTargetStatus } from '../lifecycle/state-machine.js';
import type { InboxAction, InboxCategory, InboxItem, InboxResult } from './types.js';
import { INBOX_CATEGORIES } from './types.js';

export type {
  InboxAction,
  InboxCategory,
  InboxItem,
  InboxResult,
} from './types.js';
export { INBOX_CATEGORIES } from './types.js';

/**
 * The minimal lifecycle status-config the inbox core needs for accept-verb
 * derivation. A structural subset of the dashboard's `ResolvedStatusConfig`, so
 * callers (CLI / API) just pass `getStatusConfig()`'s result. The core itself
 * never resolves config.
 */
export interface InboxStatusConfig {
  /** Status definitions; `terminal` marks a done state. */
  statuses: Array<{ id: string; terminal?: boolean }>;
  /** Transition definitions (used to enumerate the candidate commands). */
  transitions: Array<{ from: string; command: string; to: string }>;
  /** `from:command` → `to` lookup table (drives `getTargetStatus`). */
  transitionTable: Map<string, string>;
  /** Statuses whose disposition is terminal. */
  terminalStatuses: ReadonlySet<string>;
}

export interface ComputeInboxOptions {
  projectsDir: string;
  /** Standalone assignments dir; `null` to skip standalone. */
  assignmentsDir: string | null;
  /** Restrict to one project slug (matches `InboxItem.project`). */
  project?: string;
  /** Restrict to a subset of categories. */
  types?: InboxCategory[];
  /** Truncate the returned `items` list (counts/total stay full). */
  limit?: number;
  /** Resolved lifecycle status-config (for accept-verb derivation). */
  statusConfig: InboxStatusConfig;
  /** Injectable clock for `ageMs` (defaults to `Date.now()`). */
  now?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Predicates (pure) — derived-status based, parity with the board derivation.
// ─────────────────────────────────────────────────────────────────────────────

/** review = derived `status === 'review'`. */
export function isReview(a: ParsedAssignmentFull): boolean {
  return a.status === 'review';
}

/**
 * blocked = derived `status === 'blocked'` (parity with `progress['blocked']`).
 * `blockedReason` is NOT the predicate — it only feeds `summary`.
 */
export function isBlocked(a: ParsedAssignmentFull): boolean {
  return a.status === 'blocked';
}

/** A single unresolved question comment. */
export function isUnresolvedQuestion(c: ParsedComment): boolean {
  return c.type === 'question' && c.resolved !== true;
}

/** All unresolved question comments (one inbox item per). */
export function unresolvedQuestions(comments: ParsedComment[]): ParsedComment[] {
  return comments.filter(isUnresolvedQuestion);
}

/**
 * plan-approval = `status === 'ready_for_planning'` AND a latest plan file
 * exists AND it is not yet approved. The status guard is load-bearing (see the
 * Category Inventory). Async because it reuses `latestPlanFile`/`isPlanApproved`
 * (facts.ts) — do NOT reimplement digest logic.
 */
export async function isPlanAwaitingApproval(
  a: ParsedAssignmentFull,
  assignmentDir: string,
): Promise<boolean> {
  if (a.status !== 'ready_for_planning') return false;
  const latest = await latestPlanFile(assignmentDir);
  if (latest === null) return false;
  const approved = await isPlanApproved(assignmentDir, { planApproval: a.planApproval });
  return !approved;
}

// ─────────────────────────────────────────────────────────────────────────────
// `since` resolver (pure) — always returns a valid RFC 3339 via a fallback chain.
// ─────────────────────────────────────────────────────────────────────────────

/** Strip millis to canonical RFC 3339 with a trailing `Z` (e.g. `…:00Z`). */
function canonicalRfc3339(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * A non-empty, parseable timestamp NORMALIZED to canonical RFC 3339 (UTC, no
 * millis), else null. Normalizing here means every `since` the inbox emits is
 * canonical: a date-only `2026-06-01` becomes `2026-06-01T00:00:00Z`, and an
 * already-canonical `2026-06-17T03:54:48Z` round-trips unchanged.
 */
function validTimestamp(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const t = value.trim();
  if (t.length === 0) return null;
  const ms = Date.parse(t);
  return Number.isNaN(ms) ? null : canonicalRfc3339(ms);
}

/** `.at` of the latest statusHistory entry (by parseable timestamp), else null. */
function latestStatusHistoryAt(a: ParsedAssignmentFull): string | null {
  let best: { at: string; ms: number } | null = null;
  for (const e of a.statusHistory) {
    const at = validTimestamp(e.at);
    if (at === null) continue;
    const ms = Date.parse(at);
    if (best === null || ms >= best.ms) best = { at, ms };
  }
  return best?.at ?? null;
}

/** `.at` of the latest statusHistory entry matching `pred`, else null. */
function latestStatusHistoryAtWhere(
  a: ParsedAssignmentFull,
  pred: (e: ParsedAssignmentFull['statusHistory'][number]) => boolean,
): string | null {
  let best: { at: string; ms: number } | null = null;
  for (const e of a.statusHistory) {
    if (!pred(e)) continue;
    const at = validTimestamp(e.at);
    if (at === null) continue;
    const ms = Date.parse(at);
    if (best === null || ms >= best.ms) best = { at, ms };
  }
  return best?.at ?? null;
}

/**
 * Resolve `since` for a category with the shared fallback chain
 * (category-specific entry → latest statusHistory `.at` → frontmatter `updated`
 * → `created` → caller's `now`). Always returns a valid RFC 3339.
 */
export function resolveSince(
  category: InboxCategory,
  a: ParsedAssignmentFull,
  now: number,
  comment?: ParsedComment,
): string {
  let primary: string | null = null;
  switch (category) {
    case 'review':
      primary = latestStatusHistoryAtWhere(a, (e) => e.to === 'review');
      break;
    case 'blocked':
      primary = latestStatusHistoryAtWhere(a, (e) => e.dispositionTo === 'blocked');
      break;
    case 'question':
      primary = validTimestamp(comment?.timestamp);
      break;
    case 'plan-approval':
      primary = latestStatusHistoryAt(a);
      break;
  }
  return (
    primary ??
    latestStatusHistoryAt(a) ??
    validTimestamp(a.updated) ??
    validTimestamp(a.created) ??
    canonicalRfc3339(now)
  );
}

/** `max(0, now − Date.parse(since))`; non-parseable `since` clamps to 0. */
export function computeAgeMs(since: string, now: number): number {
  const ms = Date.parse(since);
  if (Number.isNaN(ms)) return 0;
  return Math.max(0, now - ms);
}

// ─────────────────────────────────────────────────────────────────────────────
// Accept-verb derivation (pure) — from the lifecycle status-config.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The lifecycle verbs that `src/index.ts` registers as real CLI subcommands. A
 * derived review verb is only RUNNABLE (CLI `syntaur <verb>` + dashboard
 * `POST transitions/<verb>`) when it is one of these — there is no generic
 * `syntaur transition` fallback. Anything outside this set is non-runnable, so
 * the derivation rejects it (e.g. a custom `review→shipped` command named
 * `ship`).
 */
export const KNOWN_TRANSITION_CLI_VERBS = new Set<string>([
  'start',
  'complete',
  'fail',
  'reopen',
  'block',
  'unblock',
  'review',
]);

export interface ReviewVerbs {
  /**
   * Primary "Accept" command (a known CLI verb whose target is terminal and is
   * not `fail`), or `null` when none qualifies. NO hardcoded fallback.
   */
  accept: string | null;
  /**
   * "Reopen" command — a known CLI verb (`start`/`reopen`) whose target is an
   * active (non-terminal) status — or `null` when none qualifies.
   */
  reopen: string | null;
}

/**
 * Derive the accept/reopen commands available from `review`, constrained to
 * RUNNABLE CLI verbs (`KNOWN_TRANSITION_CLI_VERBS`) and classified by their
 * target status's disposition:
 *
 * - `accept`: a review-valid command whose target ∈ `terminalStatuses`, that is
 *   NOT `fail`, and is a known CLI verb. Prefers `'complete'`; else the first
 *   qualifier; else `null` (no hardcoded fallback — an unrunnable target yields
 *   null so the dashboard hides the inline Accept).
 * - `reopen`: a review-valid command in `{'start','reopen'}` (both target the
 *   active `in_progress`, never blocked/parked). Prefers `'start'`, else
 *   `'reopen'`, else `null`.
 *
 * Valid commands are those `c` where `getTargetStatus('review', c, table)` is
 * non-null, enumerated from the declared `transitions` (from==='review') plus a
 * sweep of `transitionTable` keys (`review:*`).
 */
export function deriveReviewVerbs(config: InboxStatusConfig): ReviewVerbs {
  const candidates = new Set<string>();
  for (const t of config.transitions) {
    if (t.from === 'review') candidates.add(t.command);
  }
  for (const key of config.transitionTable.keys()) {
    if (key.startsWith('review:')) candidates.add(key.slice('review:'.length));
  }

  const terminalAccept: string[] = [];
  const activeReopen: string[] = [];
  for (const command of candidates) {
    const target = getTargetStatus('review', command, config.transitionTable);
    if (target === null) continue;
    const isTerminal = config.terminalStatuses.has(target);
    if (
      isTerminal &&
      command !== 'fail' &&
      KNOWN_TRANSITION_CLI_VERBS.has(command)
    ) {
      terminalAccept.push(command);
    }
    if (!isTerminal && (command === 'start' || command === 'reopen')) {
      activeReopen.push(command);
    }
  }

  const accept =
    terminalAccept.find((c) => c === 'complete') ?? terminalAccept[0] ?? null;
  const reopen =
    activeReopen.find((c) => c === 'start') ??
    activeReopen.find((c) => c === 'reopen') ??
    null;
  return { accept, reopen };
}

// ─────────────────────────────────────────────────────────────────────────────
// Action descriptor (pure) — exact CLI command strings (AC4 contract).
// ─────────────────────────────────────────────────────────────────────────────

/** `--project <p>` for project assignments; omitted (target is the UUID) for standalone. */
function targetAndProject(item: {
  project: string | null;
  assignmentSlug: string;
  assignmentId: string;
}): { target: string; projectFlag: string } {
  if (item.project === null) {
    return { target: item.assignmentId, projectFlag: '' };
  }
  return { target: item.assignmentSlug, projectFlag: ` --project ${item.project}` };
}

export function buildAction(
  category: InboxCategory,
  item: { project: string | null; assignmentSlug: string; assignmentId: string },
  ctx: { acceptCommand?: string | null; reopenCommand?: string | null; commentId?: string },
): InboxAction {
  const { target, projectFlag } = targetAndProject(item);
  switch (category) {
    case 'review':
      // Prefer the runnable Accept verb; else Reopen; else an inspect fallback
      // (realistically unreachable since the default config derives 'complete').
      if (ctx.acceptCommand) {
        return {
          verb: 'Accept',
          command: `syntaur ${ctx.acceptCommand} ${target}${projectFlag}`,
        };
      }
      if (ctx.reopenCommand) {
        return {
          verb: 'Reopen',
          command: `syntaur ${ctx.reopenCommand} ${target}${projectFlag}`,
        };
      }
      return {
        verb: 'Review',
        command: `syntaur timeline ${target}${projectFlag}`,
      };
    case 'blocked':
      return {
        verb: 'Unblock',
        command: `syntaur unblock ${target}${projectFlag}`,
      };
    case 'question':
      return {
        verb: 'Answer',
        command: `syntaur comment ${target} "<answer>" --reply-to ${ctx.commentId ?? ''}${projectFlag}`,
      };
    case 'plan-approval':
      return {
        verb: 'Approve plan',
        command: `syntaur plan approve ${target}${projectFlag}`,
      };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Ordering (pure) — most-urgent (largest ageMs) first within each category.
// ─────────────────────────────────────────────────────────────────────────────

/** Stable sort: largest `ageMs` first (most urgent). */
export function orderByUrgency(items: InboxItem[]): InboxItem[] {
  return [...items].sort((x, y) => y.ageMs - x.ageMs);
}

// ─────────────────────────────────────────────────────────────────────────────
// Aggregation entry point.
// ─────────────────────────────────────────────────────────────────────────────

function summarizeQuestion(c: ParsedComment): string {
  const body = c.body.replace(/\s+/g, ' ').trim();
  const clipped = body.length > 140 ? `${body.slice(0, 137)}...` : body;
  return clipped.length > 0 ? clipped : '(empty question)';
}

export async function computeInbox(opts: ComputeInboxOptions): Promise<InboxResult> {
  const now = opts.now ?? Date.now();
  const typeFilter = opts.types && opts.types.length > 0 ? new Set(opts.types) : null;
  const reviewVerbs = deriveReviewVerbs(opts.statusConfig);

  const walk = await listAssignmentsByProject(opts.projectsDir, opts.assignmentsDir);

  const matched: InboxItem[] = [];

  for (const entry of walk.withAssignmentMd) {
    // Honor the project filter against the inbox `project` field (null = standalone).
    if (opts.project !== undefined && entry.projectSlug !== opts.project) continue;

    let parsed: ParsedAssignmentFull;
    try {
      const content = await readFile(resolve(entry.assignmentDir, 'assignment.md'), 'utf-8');
      parsed = parseAssignmentFull(content);
    } catch {
      continue; // unreadable/unparseable assignment.md → skip (not awaiting action)
    }

    // Skip archived up front — an archived item is not awaiting action.
    if (parsed.archived) continue;

    // Skip parked/terminal-disposition assignments up front — they are not
    // awaiting a human decision (matches the plan's exclusions, and guards a
    // malformed `disposition:parked, status:review`). Blocked + active flow on.
    if (parsed.disposition === 'parked' || parsed.disposition === 'terminal') continue;

    const project = entry.projectSlug;
    const assignmentSlug = entry.assignmentSlug;
    const assignmentId = parsed.id;
    const title = parsed.title;
    const baseItem = { project, assignmentSlug, assignmentId };

    // ── review ──────────────────────────────────────────────────────────────
    if ((!typeFilter || typeFilter.has('review')) && isReview(parsed)) {
      const since = resolveSince('review', parsed, now);
      matched.push({
        ...baseItem,
        title,
        category: 'review',
        since,
        ageMs: computeAgeMs(since, now),
        summary: parsed.reviewRequested
          ? 'Review requested — awaiting accept or reopen.'
          : 'Awaiting review — accept or reopen.',
        acceptCommand: reviewVerbs.accept,
        reopenCommand: reviewVerbs.reopen,
        action: buildAction('review', baseItem, {
          acceptCommand: reviewVerbs.accept,
          reopenCommand: reviewVerbs.reopen,
        }),
      });
    }

    // ── blocked ─────────────────────────────────────────────────────────────
    if ((!typeFilter || typeFilter.has('blocked')) && isBlocked(parsed)) {
      const since = resolveSince('blocked', parsed, now);
      matched.push({
        ...baseItem,
        title,
        category: 'blocked',
        since,
        ageMs: computeAgeMs(since, now),
        summary: parsed.blockedReason
          ? `Blocked: ${parsed.blockedReason}`
          : 'Blocked — awaiting unblock.',
        action: buildAction('blocked', baseItem, {}),
      });
    }

    // ── question ────────────────────────────────────────────────────────────
    if (!typeFilter || typeFilter.has('question')) {
      const commentsPath = resolve(entry.assignmentDir, 'comments.md');
      if (await fileExists(commentsPath)) {
        try {
          const content = await readFile(commentsPath, 'utf-8');
          const parsedComments = parseComments(content);
          for (const c of unresolvedQuestions(parsedComments.entries)) {
            const since = resolveSince('question', parsed, now, c);
            matched.push({
              ...baseItem,
              title,
              category: 'question',
              since,
              ageMs: computeAgeMs(since, now),
              summary: summarizeQuestion(c),
              commentId: c.id,
              action: buildAction('question', baseItem, {
                commentId: c.id,
              }),
            });
          }
        } catch {
          // unreadable comments.md → no question items for this assignment
        }
      }
    }

    // ── plan-approval ─────────────────────────────────────────────────────────
    if (!typeFilter || typeFilter.has('plan-approval')) {
      if (await isPlanAwaitingApproval(parsed, entry.assignmentDir)) {
        const since = resolveSince('plan-approval', parsed, now);
        matched.push({
          ...baseItem,
          title,
          category: 'plan-approval',
          since,
          ageMs: computeAgeMs(since, now),
          summary: 'Plan awaiting approval.',
          action: buildAction('plan-approval', baseItem, {}),
        });
      }
    }
  }

  // Counts/total reflect the FULL matched set (before `limit` truncation).
  const counts: Record<InboxCategory, number> = {
    review: 0,
    blocked: 0,
    question: 0,
    'plan-approval': 0,
  };
  for (const item of matched) counts[item.category]++;
  const total = matched.length;

  // Order most-urgent first WITHIN each category, in canonical category order.
  const ordered: InboxItem[] = [];
  for (const category of INBOX_CATEGORIES) {
    ordered.push(...orderByUrgency(matched.filter((i) => i.category === category)));
  }

  // `limit` truncates the returned items list only (counts/total stay full).
  const items =
    opts.limit !== undefined && opts.limit >= 0 ? ordered.slice(0, opts.limit) : ordered;

  return { items, counts, total };
}
