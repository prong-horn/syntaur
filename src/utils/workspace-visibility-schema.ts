/**
 * Shared schema + pure helpers for the left-nav workspace-visibility preference.
 *
 * The preference is a BLOCKLIST of hidden workspace names: a workspace whose
 * name is absent from the list is shown. Newly created/discovered workspaces
 * therefore default to visible — hiding is strictly opt-in.
 *
 * This module is dependency-free (no imports from config.ts) so it can be
 * consumed by both the CLI/backend and the dashboard (via the `@shared` alias)
 * and unit-tested in the node-env vitest setup.
 */

/**
 * The reserved name for the synthesized "Ungrouped" pseudo-workspace shown in
 * the sidebar when there are standalone projects/assignments with no workspace.
 * It is never returned by `listWorkspaces()`; the sidebar appends it. It is
 * treated as an ordinary blocklist member, so it can be hidden like any other.
 */
export const UNGROUPED_WORKSPACE = '_ungrouped' as const;

export interface WorkspaceVisibilityConfig {
  /** Names of workspaces hidden from the left nav. Absent = visible. */
  hidden: string[];
}

/**
 * Upper bound on a single workspace name. Real workspace slugs/group names are
 * short; this only guards against a pathological config.md entry.
 */
export const MAX_WORKSPACE_NAME_LENGTH = 256;

/**
 * Normalize a raw blocklist (from disk, an API body, or a fetch response) into
 * a clean `string[]`: keep only strings, trim each, drop empties, anything
 * containing a line break, and absurdly long names, then dedupe preserving
 * first-seen order. Used on both the server (POST validation) and the client
 * (response `normalize`) so the rules are identical on both sides.
 */
export function normalizeHiddenList(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of input) {
    if (typeof raw !== 'string') continue;
    const name = raw.trim();
    if (name.length === 0) continue;
    if (name.length > MAX_WORKSPACE_NAME_LENGTH) continue;
    if (/[\r\n]/.test(name)) continue;
    if (seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

/**
 * Pure filter: return `all` minus any name present in `hidden`, preserving the
 * input order. `_ungrouped` is filtered like any other name (no special case).
 */
export function visibleWorkspaces(all: string[], hidden: string[]): string[] {
  if (hidden.length === 0) return [...all];
  const blocked = new Set(hidden);
  return all.filter((name) => !blocked.has(name));
}

/** True when `name` is present in the blocklist. */
export function isWorkspaceHidden(name: string, hidden: string[]): boolean {
  return hidden.includes(name);
}
