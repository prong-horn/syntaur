import type { StatusResolution } from '../hooks/useStatusConfig';

export interface EditableStatusLike {
  id: string;
  label: string;
  description?: string;
  color?: string;
  terminal?: boolean;
}

export interface SavePayloadInput {
  statuses: EditableStatusLike[];
  order: string[];
  pendingResolutions: Map<string, StatusResolution>;
}

export interface SavePayload {
  body: {
    statuses: Array<{ id: string; label: string; description?: string; color?: string; terminal?: true }>;
    order: string[];
    transitions: never[];
    resolutions: StatusResolution[];
  };
  resolutions: StatusResolution[];
}

/**
 * Build the POST /api/config/statuses payload from the SettingsPage's
 * current edit state + pending resolutions. Pure function — testable
 * without React or DOM. AC #9's cancel-path is verified at this layer:
 * a Cancel-flow leaves pendingResolutions empty, so the built body's
 * resolutions array is empty too.
 */
export function buildStatusSavePayload(input: SavePayloadInput): SavePayload {
  const resolutions = Array.from(input.pendingResolutions.values());
  const statuses = input.statuses.map((s) => ({
    id: s.id,
    label: s.label,
    ...(s.description ? { description: s.description } : {}),
    ...(s.color ? { color: s.color } : {}),
    ...(s.terminal ? { terminal: true as const } : {}),
  }));
  return {
    body: {
      statuses,
      order: input.order,
      transitions: [],
      resolutions,
    },
    resolutions,
  };
}

/**
 * Order a status list to match the persisted display order (`config.order`).
 * Statuses whose id appears in `order` come first, in `order`'s sequence;
 * any statuses absent from `order` are appended in their original relative
 * order; ids in `order` with no matching status are ignored. Pure — used to
 * hydrate the merged Status Definitions list so its row order reflects the
 * saved display order (consumed by Kanban columns, progress bars, dropdowns).
 *
 * Implemented as a stable sort by order-rank so it NEVER drops rows: if two
 * statuses share an id (a malformed config the save path doesn't reject), both
 * survive — keyed-Map dedup would have silently lost one on reload.
 */
export function sortStatusesByOrder<T extends { id: string }>(statuses: T[], order: string[]): T[] {
  const rank = new Map<string, number>();
  order.forEach((id, i) => {
    if (!rank.has(id)) rank.set(id, i); // first occurrence wins for duplicate order entries
  });
  const fallback = order.length; // statuses missing from `order` sort after all ranked ones
  return statuses
    .map((s, i) => ({ s, originalIndex: i, r: rank.get(s.id) ?? fallback }))
    .sort((a, b) => a.r - b.r || a.originalIndex - b.originalIndex)
    .map((entry) => entry.s);
}

/**
 * After a save attempt that has just cleared/refreshed the saved state,
 * drop any pending resolutions whose `id` no longer matches a dropped id
 * OR whose remap `target` no longer exists in the saved set. Returns the
 * new map (caller can compare reference to detect drift).
 */
export function pruneStaleResolutions(
  pending: Map<string, StatusResolution>,
  savedIds: Set<string>,
): Map<string, StatusResolution> {
  const next = new Map<string, StatusResolution>();
  for (const [key, r] of pending.entries()) {
    // If the id is back in saved (user re-added the status), the resolution
    // no longer applies.
    if (savedIds.has(r.id)) continue;
    // If the remap target was removed, drop the resolution — caller will
    // re-prompt.
    if (r.mode === 'remap' && !savedIds.has(r.target)) continue;
    next.set(key, r);
  }
  return next;
}
