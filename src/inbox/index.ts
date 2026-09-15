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
import { parseTicketFull, type ParsedTicketFull } from '../dashboard/parser.js';
import { isPlanApproved } from '../ticket-templates/plan-facts.js';
import { logRoleFile, planRoleFile } from '../ticket-templates/manifest.js';
import { openQuestions, parseLogEntries, type LogEntry } from '../ticket-templates/log-reader.js';
import { loadTemplate } from '../ticket-templates/registry.js';
import { syntaurRoot } from '../utils/paths.js';
import { TERMINAL_STAGES, VERBS } from '../lifecycle/types.js';
import { GATE_HINTS } from '../ticket-templates/gates.js';
import {
  initEventsDb,
  latestCreatedByTicket,
  latestMovedToStageByTicket,
  latestMovesByTicket,
} from '../db/events-db.js';
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
 * callers (CLI / API) just pass `getStageTableConfig()`'s result. The core itself
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
   * Status ids that are not valid active "reopen" targets (blocked/parked
   * headline stages). Optional: when absent, `deriveReviewVerbs` treats it as
   * the empty set.
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

/** Open question log entries (one inbox item per). */
export function unresolvedLogQuestions(entries: LogEntry[]): LogEntry[] {
  return openQuestions(entries);
}

/**
 * plan-approval = plan-role file present on a non-terminal ticket and not yet
 * approved (`isPlanApproved`). Uses `plan.file` when set, else the template's
 * plan role path.
 */
export async function isPlanAwaitingApproval(
  a: ParsedTicketFull,
  ticketDir: string,
): Promise<boolean> {
  if (TERMINAL_STAGES.has(a.status as 'done' | 'dropped')) return false;
  const templateId = a.template ?? 'feature';
  let manifest;
  try {
    manifest = await loadTemplate(syntaurRoot(), templateId);
  } catch {
    return false;
  }
  const planRole = planRoleFile(manifest);
  if (!planRole) return false;
  const planPath = a.plan.file
    ? resolve(ticketDir, a.plan.file)
    : resolve(ticketDir, planRole.path);
  if (!(await fileExists(planPath))) return false;
  const approved = await isPlanApproved(ticketDir, { plan: a.plan });
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

function latestMoveAt(ticketId: string): string | null {
  try {
    initEventsDb();
    const move = latestMovesByTicket([ticketId]).get(ticketId);
    return move ? validTimestamp(move.at) : null;
  } catch {
    return null;
  }
}

/**
 * Resolve `since` for a category with the shared fallback chain
 * (category-specific entry → latest `moved` into the relevant stage → frontmatter
 * `updated` → `created` → caller's `now`). Always returns a valid RFC 3339.
 */
export function resolveSince(
  category: InboxCategory,
  a: ParsedTicketFull,
  now: number,
  questionTs?: string | null,
): string {
  let primary: string | null = null;
  if (category === 'question') {
    primary = validTimestamp(questionTs ?? null);
  } else {
    try {
      initEventsDb();
      if (category === 'review') {
        primary = validTimestamp(latestMovedToStageByTicket([a.id], 'review').get(a.id)?.at);
      } else if (category === 'plan-approval') {
        primary = validTimestamp(latestMovedToStageByTicket([a.id], 'planning').get(a.id)?.at);
      }
    } catch {
      /* events db unavailable — fall through to frontmatter timestamps */
    }
  }
  let createdAt: string | null = null;
  try {
    initEventsDb();
    createdAt = validTimestamp(latestCreatedByTicket([a.id]).get(a.id));
  } catch {
    /* optional */
  }
  return (
    primary ??
    latestMoveAt(a.id) ??
    createdAt ??
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
 * `POST verbs/<verb>`) when it is one of these — there is no generic
 * `syntaur transition` fallback. Anything outside this set is non-runnable, so
 * the derivation rejects it (e.g. a custom `review→shipped` command named
 * `ship`).
 */
/** Runnable lifecycle CLI verbs (see `src/lifecycle/types.ts` `VERBS`). */
export const KNOWN_CLI_VERBS = new Set<string>(VERBS);

/** @deprecated Use {@link KNOWN_CLI_VERBS} */
export const KNOWN_TRANSITION_CLI_VERBS = KNOWN_CLI_VERBS;

export interface ReviewVerbs {
  /** Primary Accept verb (`done`). */
  accept: string | null;
  /**
   * @deprecated v2 review queue does not reopen — use {@link logReviewHint}.
   */
  reopen: string | null;
  /** Gate hint when review is not yet clean (log an approving review). */
  logReviewHint: string;
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
/** Fixed review-stage verbs (v2): accept via `done`; otherwise log a review. */
export function deriveReviewVerbs(_config?: InboxStatusConfig): ReviewVerbs {
  return {
    accept: 'done',
    reopen: null,
    logReviewHint: GATE_HINTS['review-clean'],
  };
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
    logReviewHint?: string;
    questionTs?: string;
    chat?: InboxChatRef;
    dashboardUrl?: string;
  },
): InboxAction {
  const { target, projectFlag } = targetAndProject(item);
  switch (category) {
    case 'review':
      if (ctx.acceptCommand) {
        return {
          verb: 'Accept',
          command: `syntaur ${ctx.acceptCommand} ${target}${projectFlag}`,
        };
      }
      if (ctx.logReviewHint) {
        return {
          verb: 'Log review',
          command: ctx.logReviewHint,
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
        command: `syntaur log ${target} -t answer --answers ${ctx.questionTs ?? '<ts>'} "<answer>"${projectFlag}`,
      };
    case 'plan-approval':
      return {
        verb: 'Approve plan',
        command: `syntaur approve ${target}${projectFlag}`,
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
  return `${item.since}|${item.ticketUpdated}|${item.chat?.itemId ?? item.questionTs ?? ''}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Aggregation entry point.
// ─────────────────────────────────────────────────────────────────────────────

function rawQuestionText(e: LogEntry): string {
  const { ref, text } = parseChatQuestionMarker(e.body);
  const body = (ref ? text : e.body).trim();
  return body.length > 0 ? body : '(empty question)';
}

function collapsedQuestionText(e: LogEntry): string {
  return rawQuestionText(e).replace(/\s+/g, ' ');
}

function summarizeQuestion(e: LogEntry): string {
  const body = collapsedQuestionText(e);
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

    // Skip parked tickets — not awaiting a human decision. Blocked + active flow on.
    if (parsed.parked) continue;

    // Skip terminal-status tickets so unresolved questions cannot leak in.
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
        summary: 'Awaiting review — accept or reopen.',
        acceptCommand: reviewVerbs.accept,
        reopenCommand: reviewVerbs.reopen,
        logReviewHint: reviewVerbs.logReviewHint,
        action: buildAction('review', baseItem, {
          acceptCommand: reviewVerbs.accept,
          reopenCommand: reviewVerbs.reopen,
          logReviewHint: reviewVerbs.logReviewHint,
        }),
      });
    }

    // ── question ────────────────────────────────────────────────────────────
    if (!typeFilter || typeFilter.has('question')) {
      try {
        const manifest = await loadTemplate(syntaurRoot(), parsed.template ?? 'feature');
        const logRole = logRoleFile(manifest);
        if (logRole) {
          const logPath = resolve(entry.ticketDir, logRole.path);
          if (await fileExists(logPath)) {
            const content = await readFile(logPath, 'utf-8');
            const journalTab = `file:${logRole.path}`;
            for (const q of unresolvedLogQuestions(parseLogEntries(content))) {
              const { ref } = parseChatQuestionMarker(q.body);
              const chat = ref ? { ...ref, agentId: q.author ?? 'human' } : undefined;
              const since = resolveSince('question', parsed, now, q.timestamp);
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
                summary: summarizeQuestion(q),
                body: rawQuestionText(q),
                questionTs: q.timestamp,
                journalTab,
                chat,
                ...(card !== undefined ? { card } : {}),
                action: buildAction('question', baseItem, {
                  questionTs: q.timestamp,
                  chat,
                  dashboardUrl,
                }),
              });
            }
          }
        }
      } catch {
        // unreadable log → no question items for this ticket
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
