/**
 * Pure aggregation core for the "Needs me" decision inbox.
 *
 * `computeInbox` does ONE O(n) directory scan via `listTicketsByProject`,
 * then for each entry does ONE read+parse of `ticket.md` (via the full
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
import { listTicketsByProject } from '../utils/ticket-walk.js';
import {
  parseTicketFull,
  parseComments,
  type ParsedTicketFull,
  type ParsedComment,
} from '../dashboard/parser.js';
import { latestPlanFile, isPlanApproved } from '../lifecycle/facts.js';
import { getTargetStatus } from '../lifecycle/state-machine.js';
import type {
  InboxAction,
  InboxCard,
  InboxCategory,
  InboxChatRef,
  InboxItem,
  InboxResult,
  InboxTier,
  SnoozeMap,
} from './types.js';
import { parseChatQuestionMarker } from '../chat/questions.js';
import type { ChatItem, PermissionRequestItem, QuestionItem } from '../chat/types.js';

export type {
  InboxAction,
  InboxCard,
  InboxCategory,
  InboxChatRef,
  InboxItem,
  InboxResult,
  InboxTier,
  SnoozeEntry,
  SnoozeMap,
} from './types.js';
export { INBOX_CATEGORIES } from './types.js';
export {
  snoozeFilePath,
  readSnoozes,
  writeSnoozes,
  setSnooze,
  clearSnooze,
  pruneSnoozes,
} from './snooze.js';

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
  /**
   * The configured blocked + parked HEADLINE status ids — statuses that are NOT
   * valid active "reopen" targets. Callers build this from the resolved derive
   * config's `headline.{blocked,parked}` (defaulting to `DEFAULT_DERIVE_CONFIG`
   * when the user has no custom derive rules). Optional: when absent,
   * `deriveReviewVerbs` treats it as the empty set (no extra exclusion).
   * Used by `deriveReviewVerbs` so a malformed `review:start -> blocked`/`parked`
   * is correctly NOT labeled "Reopen".
   */
  blockedParkedStatuses?: ReadonlySet<string>;
}

export interface ComputeInboxOptions {
  projectsDir: string;
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
  /** Dashboard origin without trailing slash (for chat row links). */
  dashboardUrl?: string;
  /** Optional chat-item lookup for permission/ask card enrichment. */
  lookupChatItem?: (itemId: string) => ChatItem | null;
  /** Drop rows older than this unless tier 0 (live cards). */
  maxAgeMs?: number;
  /** Active snooze entries keyed by `inboxRowKey`. */
  snoozes?: SnoozeMap;
  /** When set, snoozed rows are kept in `items` flagged `snoozed`. */
  includeSnoozed?: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Predicates (pure) — derived-status based, parity with the board derivation.
// ─────────────────────────────────────────────────────────────────────────────

/** review = derived `status === 'review'`. */
export function isReview(a: ParsedTicketFull): boolean {
  return a.status === 'review';
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
  a: ParsedTicketFull,
  ticketDir: string,
): Promise<boolean> {
  if (a.status !== 'ready_for_planning') return false;
  const latest = await latestPlanFile(ticketDir);
  if (latest === null) return false;
  const approved = await isPlanApproved(ticketDir, { planApproval: a.planApproval });
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
function latestStatusHistoryAt(a: ParsedTicketFull): string | null {
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
  a: ParsedTicketFull,
  pred: (e: ParsedTicketFull['statusHistory'][number]) => boolean,
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
  a: ParsedTicketFull,
  now: number,
  comment?: ParsedComment,
): string {
  let primary: string | null = null;
  switch (category) {
    case 'review':
      primary = latestStatusHistoryAtWhere(a, (e) => e.to === 'review');
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
 * - `reopen`: a review-valid command in `{'start','reopen'}` whose target is an
 *   ACTIVE status — non-terminal AND not a blocked/parked headline status (the
 *   target's disposition, not just the command name, is what qualifies it). The
 *   default `review:start -> in_progress` stays valid; a custom/malformed
 *   `review:start -> blocked` or `review:reopen -> parked` is rejected. Prefers
 *   `'start'`, else `'reopen'`, else `null`.
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

  const blockedParked = config.blockedParkedStatuses ?? new Set<string>();
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
    // reopen requires the TARGET be an active status: non-terminal AND not a
    // blocked/parked headline status. (Disposition of the target, not the
    // command name, is load-bearing — a review→blocked/parked target is NOT a
    // valid reopen even when the command is `start`/`reopen`.)
    if (
      !isTerminal &&
      !blockedParked.has(target) &&
      (command === 'start' || command === 'reopen')
    ) {
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

/** `--project <p>` for project tickets; omitted (target is the UUID) for standalone. */
function targetAndProject(item: {
  project: string | null;
  ticketSlug: string;
  ticketId: string;
}): { target: string; projectFlag: string } {
  if (item.project === null) {
    return { target: item.ticketId, projectFlag: '' };
  }
  return { target: item.ticketSlug, projectFlag: ` --project ${item.project}` };
}

export function buildAction(
  category: InboxCategory,
  item: { project: string | null; ticketSlug: string; ticketId: string },
  ctx: {
    acceptCommand?: string | null;
    reopenCommand?: string | null;
    commentId?: string;
    chat?: InboxChatRef;
    dashboardUrl?: string;
  },
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
    case 'question':
      if (ctx.chat && ctx.dashboardUrl) {
        const path = chatItemPath({ ...item, chat: ctx.chat });
        return {
          verb: 'Open chat',
          command: `${ctx.dashboardUrl}${path}`,
        };
      }
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
// Card enrichment + tiered ordering (pure).
// ─────────────────────────────────────────────────────────────────────────────

/** Build card metadata from a chat item (permission/ask only). */
export function buildCard(chatItem: ChatItem | null): InboxCard | null {
  if (!chatItem) return null;
  if (chatItem.type === 'permission.request') {
    const perm = chatItem as PermissionRequestItem;
    return {
      requestId: perm.requestId,
      kind: 'permission',
      options: perm.options.map((o) => ({
        optionId: o.optionId,
        name: o.name,
        kind: o.kind,
      })),
      settled: Boolean(perm.answer || perm.cancelled || perm.timedOut),
    };
  }
  if (chatItem.type === 'question') {
    const ask = chatItem as QuestionItem;
    return {
      requestId: ask.requestId,
      kind: 'ask',
      options: ask.options,
      settled: ask.answer !== null || Boolean(ask.cancelled || ask.timedOut),
    };
  }
  return null;
}

/**
 * Urgency tier for ordering. Lower = more urgent.
 * 0: live permission/ask cards; 1: chat replies; 2: plain questions or settled cards;
 * 3: plan approvals; 4: reviews.
 */
export function inboxTier(item: Pick<InboxItem, 'category' | 'chat' | 'card'>): InboxTier {
  const kind = item.chat?.kind;
  if (kind === 'permission' || kind === 'ask') {
    if (item.card === undefined || item.card === null || item.card.settled !== true) {
      return 0;
    }
    return 2;
  }
  if (kind === 'reply') return 1;
  if (item.category === 'question') return 2;
  if (item.category === 'plan-approval') return 3;
  return 4;
}

/** Stable sort: tier ascending, then largest `ageMs` first within a tier. */
export function orderByUrgency(items: InboxItem[]): InboxItem[] {
  return [...items].sort((x, y) => inboxTier(x) - inboxTier(y) || y.ageMs - x.ageMs);
}

/** Compact RFC 3339 for inbox entry row keys (`2026-09-11T05:20:00Z` → `20260911T052000Z`). */
export function compactInboxTimestamp(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) {
    return iso.replace(/[-:]/g, '').replace(/\.\d{3}(?=Z)/i, '');
  }
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`
  );
}

/**
 * Stable row key — must stay in lockstep with `rowKey` in `dashboard/src/lib/inbox.ts`.
 * Chat rows → chat item id; log question rows → `<ID>~<compact-ts>`; ticket-level → `<ID>~<category>`.
 */
export function inboxRowKey(item: InboxItem): string {
  if (item.chat?.itemId) return item.chat.itemId;
  if (item.category === 'question') {
    return `${item.ticketId}~${compactInboxTimestamp(item.since)}`;
  }
  return `${item.ticketId}~${item.category}`;
}

/** Fingerprint for "until it changes" snoozes. */
export function rowFingerprint(item: InboxItem): string {
  return `${item.since}|${item.ticketUpdated}|${item.chat?.itemId ?? item.commentId ?? ''}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Aggregation entry point.
// ─────────────────────────────────────────────────────────────────────────────

function rawQuestionText(c: ParsedComment): string {
  const { ref, text } = parseChatQuestionMarker(c.body);
  const body = (ref ? text : c.body).trim();
  return body.length > 0 ? body : '(empty question)';
}

function collapsedQuestionText(c: ParsedComment): string {
  return rawQuestionText(c).replace(/\s+/g, ' ');
}

function summarizeQuestion(c: ParsedComment): string {
  const body = collapsedQuestionText(c);
  const clipped = body.length > 140 ? `${body.slice(0, 137)}...` : body;
  return clipped;
}

/** Dashboard path to a chat item anchor for an inbox row. */
export function chatItemPath(item: {
  project: string | null;
  ticketSlug: string;
  ticketId: string;
  chat: InboxChatRef;
}): string {
  // Every ticket, nested or standalone, is addressed at /t/<id> (decision 5).
  return `/t/${item.ticketId}?tab=chat#${item.chat.itemId}`;
}


export async function computeInbox(opts: ComputeInboxOptions): Promise<InboxResult> {
  const now = opts.now ?? Date.now();
  const dashboardUrl = opts.dashboardUrl ?? 'http://localhost:4800';
  const typeFilter = opts.types && opts.types.length > 0 ? new Set(opts.types) : null;
  const reviewVerbs = deriveReviewVerbs(opts.statusConfig);
  const walk = await listTicketsByProject(opts.projectsDir);

  const matched: InboxItem[] = [];

  for (const entry of walk.withTicketMd) {
    // Honor the project filter against the inbox `project` field (null = standalone).
    if (opts.project !== undefined && entry.projectSlug !== opts.project) continue;

    let parsed: ParsedTicketFull;
    try {
      const content = await readFile(resolve(entry.ticketDir, 'ticket.md'), 'utf-8');
      parsed = parseTicketFull(content);
    } catch {
      continue; // unreadable/unparseable ticket.md → skip (not awaiting action)
    }

    // Skip archived up front — an archived item is not awaiting action.
    if (parsed.archived) continue;

    // Skip parked/terminal-disposition tickets up front — they are not
    // awaiting a human decision (matches the plan's exclusions, and guards a
    // malformed `disposition:parked, status:review`). Blocked + active flow on.
    if (parsed.disposition === 'parked' || parsed.disposition === 'terminal') continue;

    // Skip terminal-STATUS tickets regardless of disposition. `disposition`
    // is nullable, so a legacy/null-disposition entry whose derived status is
    // terminal (completed/failed) with an unresolved question would otherwise
    // leak in via the status-agnostic question loop below. `terminalStatuses`
    // already covers completed/failed; the review/blocked/plan-approval
    // predicates already require non-terminal statuses, so they're unaffected.
    if (opts.statusConfig.terminalStatuses.has(parsed.status)) continue;

    const project = entry.projectSlug;
    const ticketSlug = entry.ticketSlug;
    const ticketId = parsed.id;
    const title = parsed.title;
    const baseItem = { project, ticketSlug, ticketId };

    // ── review ──────────────────────────────────────────────────────────────
    if ((!typeFilter || typeFilter.has('review')) && isReview(parsed)) {
      const since = resolveSince('review', parsed, now);
      matched.push({
        ...baseItem,
        title,
        category: 'review',
        since,
        ageMs: computeAgeMs(since, now),
        ticketUpdated: parsed.updated,
        // Cosmetic retired-fact read (WS-3 T9): `reviewRequested` stays
        // ENGINE-FED post-marker (the bridge writes it in the work-start CAS
        // payload), so this summary pick stays coherent in both worlds;
        // `isReview` itself keys off the derived status, not this scalar.
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

    // ── question ────────────────────────────────────────────────────────────
    if (!typeFilter || typeFilter.has('question')) {
      const commentsPath = resolve(entry.ticketDir, 'comments.md');
      if (await fileExists(commentsPath)) {
        try {
          const content = await readFile(commentsPath, 'utf-8');
          const parsedComments = parseComments(content);
          for (const c of unresolvedQuestions(parsedComments.entries)) {
            const { ref } = parseChatQuestionMarker(c.body);
            const chat = ref ? { ...ref, agentId: c.author } : undefined;
            const since = resolveSince('question', parsed, now, c);
            let card: InboxCard | null | undefined;
            if (
              chat &&
              (chat.kind === 'permission' || chat.kind === 'ask') &&
              opts.lookupChatItem
            ) {
              card = (() => {
                try {
                  return buildCard(opts.lookupChatItem!(chat.itemId));
                } catch {
                  return null;
                }
              })();
            }
            matched.push({
              ...baseItem,
              title,
              category: 'question',
              since,
              ageMs: computeAgeMs(since, now),
              ticketUpdated: parsed.updated,
              summary: summarizeQuestion(c),
              body: rawQuestionText(c),
              commentId: c.id,
              chat,
              ...(card !== undefined ? { card } : {}),
              action: buildAction('question', baseItem, {
                commentId: c.id,
                chat,
                dashboardUrl,
              }),
            });
          }
        } catch {
          // unreadable comments.md → no question items for this ticket
        }
      }
    }

    // ── plan-approval ─────────────────────────────────────────────────────────
    if (!typeFilter || typeFilter.has('plan-approval')) {
      if (await isPlanAwaitingApproval(parsed, entry.ticketDir)) {
        const since = resolveSince('plan-approval', parsed, now);
        matched.push({
          ...baseItem,
          title,
          category: 'plan-approval',
          since,
          ageMs: computeAgeMs(since, now),
          ticketUpdated: parsed.updated,
          summary: 'Plan awaiting approval.',
          action: buildAction('plan-approval', baseItem, {}),
        });
      }
    }
  }

  // Max-age window: tier 0 (live cards) is always kept.
  let filtered = matched.filter(
    (r) => opts.maxAgeMs === undefined || inboxTier(r) === 0 || r.ageMs <= opts.maxAgeMs,
  );

  // Snooze pass: honour the injected map.
  const liftedSnoozeKeys: string[] = [];
  let snoozedCount = 0;
  const visible: InboxItem[] = [];
  const countable: InboxItem[] = [];
  for (const row of filtered) {
    const key = inboxRowKey(row);
    const entry = opts.snoozes?.[key];
    if (!entry) {
      visible.push(row);
      countable.push(row);
      continue;
    }
    if (inboxTier(row) === 0) {
      visible.push(row);
      countable.push(row);
      continue;
    }
    if (entry.until === null && entry.fingerprint !== rowFingerprint(row)) {
      liftedSnoozeKeys.push(key);
      visible.push(row);
      countable.push(row);
      continue;
    }
    snoozedCount++;
    if (opts.includeSnoozed) {
      visible.push({ ...row, snoozed: { until: entry.until } });
    }
  }
  filtered = visible;

  // Counts/total reflect non-snoozed rows only (snoozed rows may appear in `items`).
  const counts: Record<InboxCategory, number> = {
    question: 0,
    review: 0,
    'plan-approval': 0,
  };
  for (const item of countable) counts[item.category]++;
  const total = countable.length;

  // Order by tier, then oldest-first within each tier (largest ageMs first).
  const ordered = orderByUrgency(filtered);

  // `limit` truncates the returned items list only (counts/total stay full).
  const items =
    opts.limit !== undefined && opts.limit >= 0 ? ordered.slice(0, opts.limit) : ordered;

  return { items, counts, total, snoozedCount, liftedSnoozeKeys };
}
