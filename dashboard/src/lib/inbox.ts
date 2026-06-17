/**
 * Pure helpers for the dashboard "Needs me" inbox view. These have no React /
 * DOM dependencies so they unit-test under the node-env dashboard vitest config
 * (`vitest.dashboard.config.ts`) — NOT jsdom.
 *
 * The SPA is a separate TS project and cannot import the backend `src/inbox/`
 * types, so the inbox wire shape is re-declared here (it mirrors
 * `src/inbox/types.ts` — the `GET /api/inbox` response contract).
 */

/** The four v1 "needs me" categories (mirrors `InboxCategory` server-side). */
export type InboxCategory = 'review' | 'blocked' | 'question' | 'plan-approval';

/** All categories in canonical render order (stable, server-aligned). */
export const INBOX_CATEGORY_ORDER: readonly InboxCategory[] = [
  'review',
  'blocked',
  'question',
  'plan-approval',
];

/** Human-facing section labels per category. */
export const CATEGORY_LABELS: Record<InboxCategory, string> = {
  review: 'Review',
  blocked: 'Blocked',
  question: 'Questions',
  'plan-approval': 'Plan approval',
};

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
  action: InboxAction;
}

export interface InboxResult {
  items: InboxItem[];
  counts: Record<InboxCategory, number>;
  total: number;
}

/** One category section: its key, label, count, and oldest-first items. */
export interface InboxGroup {
  category: InboxCategory;
  label: string;
  count: number;
  items: InboxItem[];
}

/**
 * Group items by category in the canonical stable order (review, blocked,
 * question, plan-approval). Within each group items are ordered OLDEST-FIRST
 * (largest `ageMs` first) so the most-stale decision sits at the top — matching
 * the CLI/aggregation-core ordering. Empty categories are omitted.
 */
export function groupInboxItems(items: InboxItem[]): InboxGroup[] {
  const groups: InboxGroup[] = [];
  for (const category of INBOX_CATEGORY_ORDER) {
    const matched = items
      .filter((item) => item.category === category)
      .sort((a, b) => b.ageMs - a.ageMs);
    if (matched.length === 0) continue;
    groups.push({
      category,
      label: CATEGORY_LABELS[category],
      count: matched.length,
      items: matched,
    });
  }
  return groups;
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

/**
 * Resolve the transition endpoint for an item (review accept/reopen, blocked
 * unblock). `command` comes from the item's derived `action` (review) or is the
 * literal `'unblock'` (blocked). Branches on `project === null` for standalone.
 *
 * Project:    POST /api/projects/:slug/assignments/:aslug/transitions/:command
 * Standalone: POST /api/assignments/:id/transitions/:command
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

/**
 * Resolve the comments POST endpoint (used to answer a question by replying).
 *
 * Project:    POST /api/projects/:slug/assignments/:aslug/comments
 * Standalone: POST /api/assignments/:id/comments
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
 *
 * Project:    PATCH /api/projects/:slug/assignments/:aslug/comments/:commentId/resolved
 * Standalone: PATCH /api/assignments/:id/comments/:commentId/resolved
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
 * tab (`plan` for plan-approval, `comments` for questions). Branches on
 * `project === null` for the standalone route (keyed on the UUID `assignmentId`,
 * which is the `:id` URL param).
 *
 * Project:    /projects/:slug/assignments/:aslug[?tab=...]
 * Standalone: /assignments/:id[?tab=...]
 */
export function assignmentHref(
  item: RouteIdentity,
  tab?: 'plan' | 'comments',
): string {
  const query = tab ? `?tab=${tab}` : '';
  if (item.project === null) {
    return `/assignments/${encodeURIComponent(item.assignmentId)}${query}`;
  }
  return `/projects/${encodeURIComponent(item.project)}/assignments/${encodeURIComponent(item.assignmentSlug)}${query}`;
}

/**
 * Parse the primary transition command for a `review` item out of its derived
 * `action.command` (e.g. `syntaur complete my-slug --project p` → `complete`).
 * The aggregation core derives the accept verb from the lifecycle status-config,
 * so we read it back from the command string rather than hardcoding `complete`.
 * Returns `null` if the shape is unexpected (the caller then disables the
 * inline action and the user falls back to the printed CLI command / jump link).
 */
export function parseTransitionCommand(command: string): string | null {
  // Shape: `syntaur <command> <slug> [--project <p>]`
  const match = /^syntaur\s+([a-z0-9][a-z0-9-]*)\s/i.exec(command.trim());
  if (!match) return null;
  return match[1];
}
