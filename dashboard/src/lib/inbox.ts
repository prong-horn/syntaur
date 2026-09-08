/**
 * Pure helpers for the dashboard "Needs me" inbox view. These have no React /
 * DOM dependencies so they unit-test under the node-env dashboard vitest config
 * (`vitest.dashboard.config.ts`) — NOT jsdom.
 *
 * The SPA is a separate TS project and cannot import the backend `src/inbox/`
 * types, so the inbox wire shape is re-declared here (it mirrors
 * `src/inbox/types.ts` — the `GET /api/inbox` response contract).
 */

/** The three v1 "needs me" categories (mirrors `InboxCategory` server-side). */
export type InboxCategory = 'question' | 'review' | 'plan-approval';

export type InboxChatKind = 'reply' | 'permission' | 'ask';

export interface InboxChatRef {
  kind: InboxChatKind;
  itemId: string;
  turnId?: string;
  agentId: string;
}

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

export type InboxRowKind =
  | 'reply'
  | 'permission'
  | 'ask'
  | 'plain-question'
  | 'review'
  | 'plan-approval';

export interface InboxAction {
  verb: string;
  command: string;
}

export interface InboxItem {
  /** Owning project slug; `null` for standalone assignments. */
  project: string | null;
  /** Assignment slug; for standalone, the UUID folder name. */
  assignmentSlug: string;
  /** Assignment id (UUID from frontmatter). For standalone routes, this is the URL `:id`. */
  assignmentId: string;
  title: string;
  category: InboxCategory;
  /** RFC 3339 timestamp — when the item entered its awaiting-human state. */
  since: string;
  /** `max(0, now − since)` in milliseconds. */
  ageMs: number;
  summary: string;
  /** Question rows: marker-stripped full text from the API. */
  body?: string;
  action: InboxAction;
  /** Review-only: derived CLI verb that accepts the review, or null if none. */
  acceptCommand?: string | null;
  /** Review-only: derived CLI verb that reopens the review, or null if none. */
  reopenCommand?: string | null;
  /** Question-only: the unresolved comment's id (reply `replyTo` + resolve). */
  commentId?: string;
  /** Question-only: chat-sourced row linking to a chat item. */
  chat?: InboxChatRef;
  /** Permission/ask chat rows: card options from the API. */
  card?: InboxCard | null;
}

export interface InboxResult {
  items: InboxItem[];
  counts: Record<InboxCategory, number>;
  total: number;
}

/** HTTP method + URL descriptor for a dashboard mutation. */
export interface EndpointDescriptor {
  method: 'POST' | 'PATCH';
  url: string;
}

/**
 * Identity fields needed to derive a route — the subset of `InboxItem` the URL
 * builders read. `project === null` selects the standalone routes (keyed on the
 * UUID `assignmentId`); otherwise the project-nested routes (keyed on
 * `project` + `assignmentSlug`).
 */
type RouteIdentity = Pick<InboxItem, 'project' | 'assignmentSlug' | 'assignmentId'>;

export function rowKind(item: InboxItem): InboxRowKind {
  if (item.category === 'review') return 'review';
  if (item.category === 'plan-approval') return 'plan-approval';
  if (item.category === 'question') {
    if (!item.chat) return 'plain-question';
    if (item.chat.kind === 'reply') return 'reply';
    if (item.chat.kind === 'permission') return 'permission';
    return 'ask';
  }
  return 'plain-question';
}

export function waitingLabel(item: InboxItem, author?: { name: string }): string {
  const kind = rowKind(item);
  const agentName = item.chat ? (author?.name ?? item.chat.agentId) : null;
  const agent = agentName ? `@${agentName}` : null;
  switch (kind) {
    case 'reply':
      return `${agent} asked`;
    case 'permission':
      return `${agent} is waiting for permission`;
    case 'ask':
      return `${agent} is asking`;
    case 'plan-approval':
      return 'Plan awaiting your approval';
    case 'review':
      return 'Awaiting your review';
    case 'plain-question':
      return 'Question';
  }
}

export function chatReplyText(agentId: string, text: string): string {
  return `@${agentId} ${text.trim()}`;
}

/** Sorted distinct project slugs from inbox items (`null` = standalone). */
export function projectOptions(items: InboxItem[]): Array<string | null> {
  const slugs = new Set<string | null>();
  for (const item of items) slugs.add(item.project);
  return [...slugs].sort((a, b) => {
    if (a === null) return 1;
    if (b === null) return -1;
    return a.localeCompare(b);
  });
}

/**
 * Humanize an age in milliseconds to a compact relative string ("just now",
 * "3m", "5h", "2d"). Pure (takes the already-computed `ageMs` so it needs no
 * clock); negative inputs clamp to "just now".
 */
export function formatAge(ageMs: number): string {
  if (!Number.isFinite(ageMs) || ageMs < 0) return 'just now';
  const totalSeconds = Math.floor(ageMs / 1000);
  if (totalSeconds < 60) return 'just now';
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const totalHours = Math.floor(totalMinutes / 60);
  if (totalHours < 24) return `${totalHours}h`;
  const totalDays = Math.floor(totalHours / 24);
  return `${totalDays}d`;
}

/**
 * Resolve the transition endpoint for an item (review accept/reopen).
 * Branches on `project === null` for standalone.
 */
export function transitionEndpoint(
  item: RouteIdentity,
  command: string,
): EndpointDescriptor {
  const cmd = encodeURIComponent(command);
  if (item.project === null) {
    return {
      method: 'POST',
      url: `/api/assignments/${encodeURIComponent(item.assignmentId)}/transitions/${cmd}`,
    };
  }
  return {
    method: 'POST',
    url: `/api/projects/${encodeURIComponent(item.project)}/assignments/${encodeURIComponent(item.assignmentSlug)}/transitions/${cmd}`,
  };
}

export function planApproveEndpoint(item: RouteIdentity): EndpointDescriptor {
  if (item.project === null) {
    return {
      method: 'POST',
      url: `/api/assignments/${encodeURIComponent(item.assignmentId)}/plan/approve`,
    };
  }
  return {
    method: 'POST',
    url: `/api/projects/${encodeURIComponent(item.project)}/assignments/${encodeURIComponent(item.assignmentSlug)}/plan/approve`,
  };
}

/**
 * Resolve the comments POST endpoint (used to answer a question by replying).
 */
export function commentsEndpoint(item: RouteIdentity): EndpointDescriptor {
  if (item.project === null) {
    return {
      method: 'POST',
      url: `/api/assignments/${encodeURIComponent(item.assignmentId)}/comments`,
    };
  }
  return {
    method: 'POST',
    url: `/api/projects/${encodeURIComponent(item.project)}/assignments/${encodeURIComponent(item.assignmentSlug)}/comments`,
  };
}

/**
 * Resolve the comment-resolved PATCH endpoint (mark a question answered).
 */
export function resolveCommentEndpoint(
  item: RouteIdentity,
  commentId: string,
): EndpointDescriptor {
  const cid = encodeURIComponent(commentId);
  if (item.project === null) {
    return {
      method: 'PATCH',
      url: `/api/assignments/${encodeURIComponent(item.assignmentId)}/comments/${cid}/resolved`,
    };
  }
  return {
    method: 'PATCH',
    url: `/api/projects/${encodeURIComponent(item.project)}/assignments/${encodeURIComponent(item.assignmentSlug)}/comments/${cid}/resolved`,
  };
}

/**
 * Build the SPA jump-href to an assignment's detail page, optionally targeting a
 * tab (`plan` for plan-approval, `comments` for questions).
 */
export function assignmentHref(
  item: RouteIdentity,
  tab?: 'plan' | 'comments' | 'chat',
): string {
  const query = tab ? `?tab=${tab}` : '';
  if (item.project === null) {
    return `/assignments/${encodeURIComponent(item.assignmentId)}${query}`;
  }
  return `/projects/${encodeURIComponent(item.project)}/assignments/${encodeURIComponent(item.assignmentSlug)}${query}`;
}

/** SPA href to a chat item anchor for a chat-sourced inbox row. */
export function chatItemHref(item: InboxItem): string {
  if (!item.chat) return assignmentHref(item, 'chat');
  return `${assignmentHref(item, 'chat')}#${item.chat.itemId}`;
}
