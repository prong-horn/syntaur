import type { DashboardSlot, WidgetGeometry } from '@shared/saved-views-schema';

export function nextSlotId(slots: DashboardSlot[]): string {
  const idSet = new Set(slots.map((s) => s.id));
  let maxSuffix = -1;
  for (const id of idSet) {
    const match = /^slot-(\d+)$/.exec(id);
    if (match) {
      const n = parseInt(match[1], 10);
      if (n > maxSuffix) maxSuffix = n;
    }
  }
  let n = maxSuffix + 1; // starts at 0 when no conforming ids exist
  // n = maxSuffix + 1 is never already present by construction; this loop is a defensive no-op guarding against duplicate ids in malformed input.
  while (idSet.has(`slot-${n}`)) n++;
  return `slot-${n}`;
}

export function addSlot(slots: DashboardSlot[], geometry?: WidgetGeometry): DashboardSlot[] {
  const newSlot: DashboardSlot =
    geometry !== undefined
      ? { id: nextSlotId(slots), widget: null, size: geometry }
      : { id: nextSlotId(slots), widget: null };
  return [...slots, newSlot];
}

/**
 * Returns a new array with the slot matching `id` removed.
 * A non-existent id returns a new array equal in contents to the input (still
 * immutable — always a copy, never the same reference).
 */
export function removeSlot(slots: DashboardSlot[], id: string): DashboardSlot[] {
  return slots.filter((slot) => slot.id !== id);
}
