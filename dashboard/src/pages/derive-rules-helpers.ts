/**
 * Pure helpers for the Derive Rules editor: editable-model ⇄ DeriveConfig
 * conversion (row keys for dnd-kit) and validation that reuses the exact
 * `validateDeriveConfig` the server and doctor run.
 */
import {
  validateDeriveConfig,
  type DeriveConfig,
  type PhaseRung,
  type DispositionRule,
} from '@shared/derive-config';
import type { FieldRegistry } from '@shared/query';
import { validateDeriveCondition } from '@shared/derive';

let rowKeyCounter = 0;
export function makeDeriveRowKey(): string {
  rowKeyCounter += 1;
  return `dr_${rowKeyCounter}_${Math.random().toString(36).slice(2, 8)}`;
}

export interface EditableRung {
  rowKey: string;
  phase: string;
  when: string;
  next: string;
}

export interface EditableDispRule {
  rowKey: string;
  /** null = the pinned `else:` arm. */
  when: string | null;
  is: string;
}

export interface EditableDerive {
  phaseLadder: EditableRung[];
  disposition: EditableDispRule[];
  headline: { parked: string; blocked: string };
}

export function toEditableDerive(d: DeriveConfig): EditableDerive {
  // Pin the `else:` arm (when: null) last so the UI always renders it pinned at
  // the bottom and a save can't produce an unreachable-rules ordering — the
  // runtime is first-match-wins. Non-else rules keep their relative order.
  const disposition = [...d.disposition].sort((a, b) => {
    if (a.when === null && b.when !== null) return 1;
    if (a.when !== null && b.when === null) return -1;
    return 0;
  });
  return {
    phaseLadder: d.phaseLadder.map((r) => ({
      rowKey: makeDeriveRowKey(),
      phase: r.phase,
      when: r.when,
      next: r.next ?? '',
    })),
    disposition: disposition.map((r) => ({
      rowKey: makeDeriveRowKey(),
      when: r.when,
      is: r.is,
    })),
    headline: { parked: d.headline.parked, blocked: d.headline.blocked },
  };
}

export function fromEditableDerive(e: EditableDerive): DeriveConfig {
  const phaseLadder: PhaseRung[] = e.phaseLadder.map((r) =>
    r.next.trim() ? { phase: r.phase, when: r.when, next: r.next.trim() } : { phase: r.phase, when: r.when },
  );
  const disposition: DispositionRule[] = e.disposition.map((r) => ({ when: r.when, is: r.is }));
  return {
    phaseLadder,
    disposition,
    // terminal/active are fixed by the projection contract; only parked/blocked
    // are user-configurable.
    headline: { terminal: 'passthrough', active: 'phase', parked: e.headline.parked, blocked: e.headline.blocked },
  };
}

/** The index of the `*` catch-all rung (lowest priority), or -1 if absent. */
export function catchAllIndex(rungs: EditableRung[]): number {
  return rungs.findIndex((r) => r.when.trim() === '*');
}

/**
 * Validate a derive config against the defined statuses and the accepted-fact
 * registry — same checks as the server (`validateDeriveConfig` +
 * `validateDeriveCondition`). Returns human-readable problems (empty = valid).
 */
export function validateDeriveSection(
  derive: DeriveConfig,
  statuses: Array<{ id: string }>,
  registry: FieldRegistry,
): string[] {
  return validateDeriveConfig(derive, { statuses }, (when) => validateDeriveCondition(when, registry));
}
