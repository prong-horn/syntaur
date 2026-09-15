/**
 * Deep-link route helper for search hits. Produces UNPREFIXED app paths (the
 * dashboard palette prepends the per-hit `/w/<workspace>` prefix for nested
 * ticket-pane hits). Also exports the shared `slugifyHeading` used both here
 * (for the `#section` anchor) and by the dashboard `MarkdownRenderer` heading
 * ids, so the route hash always matches a real element id.
 */

import type { FileKind, SearchHit } from './types.js';

/**
 * Content kind → the `TicketDetail` `?tab=` pane that renders it.
 */
export const FILE_KIND_TO_TAB: Record<FileKind, string> = {
  ticket: 'summary',
  plan: 'file:plan.md',
  scratchpad: 'file:scratchpad.md',
  journal: 'file:journal.md',
  handoff: 'file:handoff.md',
  progress: 'file:progress.md',
  comments: 'file:comments.md',
  'decision-record': 'file:decision-record.md',
};

/**
 * GitHub-style heading slug — lowercase, strip non-word chars, spaces → `-`.
 * Shared with the dashboard `MarkdownRenderer` heading ids so `#<slug>` anchors
 * resolve.
 */
export function slugifyHeading(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * File kinds whose dashboard pane renders its WHOLE body through
 * `MarkdownRenderer` and so gets heading `id`s a `#<slug(section)>` anchor can
 * resolve against. Excluded kinds, and why a hash there would dangle:
 *   - `comments` / `progress` — render structured list rows, NOT markdown headings.
 *   - `ticket` — the `summary` pane transforms `## Acceptance Criteria` into
 *     `SectionCard`s WITHOUT ids (TicketDetail.tsx), so its headings never
 *     become element ids.
 * These all get the `?tab=` pane WITHOUT a hash.
 */
const ANCHORABLE_KINDS: ReadonlySet<FileKind> = new Set<FileKind>([
  'plan',
  'scratchpad',
  'handoff',
  'decision-record',
  'journal',
  'progress',
  'comments',
]);

/**
 * Build the UNPREFIXED deep-link for a hit:
 *   - ticket-scoped kinds → `<base>?tab=<pane>` + optional `#<slug(section)>`,
 *     where base is `/t/<ticketId>`.
 */
export function routeForHit(
  hit: Pick<
    SearchHit,
    | 'fileKind'
    | 'projectSlug'
    | 'ticketSlug'
    | 'ticketId'
    | 'standalone'
    | 'section'
  >,
): string {
  const base = `/t/${hit.ticketId}`;

  const tab = FILE_KIND_TO_TAB[hit.fileKind];
  let route = `${base}?tab=${tab}`;
  if (hit.section && ANCHORABLE_KINDS.has(hit.fileKind)) {
    route += `#${slugifyHeading(hit.section)}`;
  }
  return route;
}
