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
