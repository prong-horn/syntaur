/**
 * Deep-link route helper for search hits. Produces UNPREFIXED app paths (the
 * dashboard palette prepends the per-hit `/w/<workspace>` prefix for nested
 * assignment-pane hits). Also exports the shared `slugifyHeading` used both here
 * (for the `#section` anchor) and by the dashboard `MarkdownRenderer` heading
 * ids, so the route hash always matches a real element id.
 */

import type { FileKind, SearchHit } from './types.js';

/**
 * Content kind → the `AssignmentDetail` `?tab=` pane that renders it. Memory and
 * resource have no assignment pane; they route to their own pages.
 */
export const FILE_KIND_TO_TAB: Record<FileKind, string> = {
  assignment: 'summary',
  plan: 'plan',
  scratchpad: 'scratchpad',
  handoff: 'handoff',
  progress: 'progress',
  comments: 'comments',
  'decision-record': 'decisions',
  // memory/resource never use a tab — routeForHit short-circuits them.
  memory: 'summary',
  resource: 'summary',
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
 *   - `comments` / `progress` — render structured components (CommentsThread /
 *     progress `<li>` rows), NOT markdown headings.
 *   - `assignment` — the `summary` pane transforms `## Acceptance Criteria` /
 *     `## Todos` into `SectionCard`s WITHOUT ids (AssignmentDetail.tsx), so its
 *     headings never become element ids.
 * These all get the `?tab=` pane WITHOUT a hash.
 */
const ANCHORABLE_KINDS: ReadonlySet<FileKind> = new Set<FileKind>([
  'plan',
  'scratchpad',
  'handoff',
  'decision-record',
]);

/**
 * Build the UNPREFIXED deep-link for a hit:
 *   - memory   → `/projects/<projectSlug>/memories/<itemSlug>`
 *   - resource → `/projects/<projectSlug>/resources/<itemSlug>`
 *   - assignment-scoped kinds → `<base>?tab=<pane>` + optional `#<slug(section)>`,
 *     where base is `/assignments/<id>` (standalone) or
 *     `/projects/<projectSlug>/assignments/<assignmentSlug>` (nested).
 */
export function routeForHit(
  hit: Pick<
    SearchHit,
    | 'fileKind'
    | 'projectSlug'
    | 'assignmentSlug'
    | 'assignmentId'
    | 'standalone'
    | 'itemSlug'
    | 'section'
  >,
): string {
  if (hit.fileKind === 'memory') {
    return `/projects/${hit.projectSlug}/memories/${hit.itemSlug}`;
  }
  if (hit.fileKind === 'resource') {
    return `/projects/${hit.projectSlug}/resources/${hit.itemSlug}`;
  }

  const base = hit.standalone
    ? `/assignments/${hit.assignmentId}`
    : `/projects/${hit.projectSlug}/assignments/${hit.assignmentSlug}`;

  const tab = FILE_KIND_TO_TAB[hit.fileKind];
  let route = `${base}?tab=${tab}`;
  if (hit.section && ANCHORABLE_KINDS.has(hit.fileKind)) {
    route += `#${slugifyHeading(hit.section)}`;
  }
  return route;
}
