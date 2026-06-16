/**
 * GitHub-style heading slug — lowercase, strip non-word chars, spaces → `-`.
 *
 * MIRRORS the backend `slugifyHeading` in `src/search/route.ts` EXACTLY so the
 * `#<slug>` anchors that the search route helper bakes into a hit's deep-link
 * resolve to the heading ids `MarkdownRenderer` emits. The dashboard is a
 * separate TS project and cannot import from `src/`, so the algorithm is copied
 * verbatim — keep the two in sync.
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
