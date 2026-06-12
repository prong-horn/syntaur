import type { StatusResolution, StatusTransition } from '../hooks/useStatusConfig';
import type { DeriveConfig } from '@shared/derive-config';
import type { EditableDerive } from './derive-rules-helpers';
import type { EditableTransition } from './transitions-helpers';

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
  /** Raw fact rows. Omit to leave facts untouched (server preserves current). */
  facts?: { name: string; type: string; binds: string | null }[];
  /** Acknowledged fact removals (clears the 409 reference guard). */
  factRemovalAcks?: string[];
  /** Presence semantics: undefined = preserve, null = reset to defaults, object = set. */
  derive?: DeriveConfig | null;
  /** Omit to preserve current transitions (e.g. while showing read-only defaults). */
  transitions?: StatusTransition[];
}

export interface SavePayload {
  body: {
    statuses: Array<{ id: string; label: string; description?: string; color?: string; terminal?: true }>;
    order: string[];
    transitions?: StatusTransition[];
    derive?: DeriveConfig | null;
    facts?: { name: string; type: string; binds: string | null }[];
    factRemovalAcks?: string[];
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
 *
 * Presence semantics mirror the server: `derive`/`transitions`/`facts` are
 * omitted from the body when their input is undefined so the server preserves
 * the current value. This is what kills the historical `transitions: []` wipe —
 * an untouched (read-only defaults) transitions section sends NOTHING rather
 * than an empty array.
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
  const body: SavePayload['body'] = {
    statuses,
    order: input.order,
    resolutions,
  };
  if (input.transitions !== undefined) body.transitions = input.transitions;
  if (input.derive !== undefined) body.derive = input.derive;
  if (input.facts !== undefined) body.facts = input.facts;
  if (input.factRemovalAcks && input.factRemovalAcks.length > 0) {
    body.factRemovalAcks = input.factRemovalAcks;
  }
  return { body, resolutions };
}

export interface StatusRuleReference {
  section: 'phaseLadder' | 'headline' | 'transitions';
  detail: string;
}

/**
 * Find every derive/transition rule that references a status id — used to warn
 * before a status is deleted. Disposition is deliberately EXCLUDED: disposition
 * rules reference `is: active|blocked|parked`, never status ids.
 */
export function findStatusRuleReferences(
  id: string,
  derive: EditableDerive,
  transitions: EditableTransition[],
): StatusRuleReference[] {
  const refs: StatusRuleReference[] = [];
  derive.phaseLadder.forEach((rung, i) => {
    if (rung.phase === id) {
      refs.push({ section: 'phaseLadder', detail: `phaseLadder rung ${i} ("${rung.phase}")` });
    }
  });
  if (derive.headline.parked === id) refs.push({ section: 'headline', detail: 'headline.parked' });
  if (derive.headline.blocked === id) refs.push({ section: 'headline', detail: 'headline.blocked' });
  for (const t of transitions) {
    if (t.from === id || t.to === id) {
      refs.push({ section: 'transitions', detail: `transition ${t.from} --${t.command}--> ${t.to}` });
    }
  }
  return refs;
}

/** True iff `headline.parked`/`blocked` references the id (needs a remap pick). */
export function headlineReferencesStatus(id: string, derive: EditableDerive): boolean {
  return derive.headline.parked === id || derive.headline.blocked === id;
}

/**
 * Remap-resolve: rewrite EVERY reference to `id` → `target` across the phase
 * ladder, headline, and transitions.
 */
export function remapStatusInDerive(derive: EditableDerive, id: string, target: string): EditableDerive {
  return {
    phaseLadder: derive.phaseLadder.map((r) => (r.phase === id ? { ...r, phase: target } : r)),
    disposition: derive.disposition,
    headline: {
      parked: derive.headline.parked === id ? target : derive.headline.parked,
      blocked: derive.headline.blocked === id ? target : derive.headline.blocked,
    },
  };
}

export function remapStatusInTransitions(
  transitions: EditableTransition[],
  id: string,
  target: string,
): EditableTransition[] {
  return transitions.map((t) => ({
    ...t,
    from: t.from === id ? target : t.from,
    to: t.to === id ? target : t.to,
  }));
}

/**
 * Delete-resolve: DROP ladder rungs that reference `id` (remapping a rung's
 * phase could create duplicate-phase rungs) and remap only the headline
 * parked/blocked refs to `headlineTarget` (headline cannot reference nothing).
 */
export function dropStatusFromDerive(
  derive: EditableDerive,
  id: string,
  headlineTarget: string,
): EditableDerive {
  return {
    phaseLadder: derive.phaseLadder.filter((r) => r.phase !== id),
    disposition: derive.disposition,
    headline: {
      parked: derive.headline.parked === id ? headlineTarget : derive.headline.parked,
      blocked: derive.headline.blocked === id ? headlineTarget : derive.headline.blocked,
    },
  };
}

/** Delete-resolve: drop transitions touching `id` (no remap needed). */
export function dropStatusFromTransitions(transitions: EditableTransition[], id: string): EditableTransition[] {
  return transitions.filter((t) => t.from !== id && t.to !== id);
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
