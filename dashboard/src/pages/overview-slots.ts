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

export function removeSlot(slots: DashboardSlot[], index: number): DashboardSlot[] {
  if (index < 0 || index >= slots.length) return [...slots];
  return slots.filter((_, i) => i !== index);
}
