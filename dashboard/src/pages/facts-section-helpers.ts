import {
  validateFactDeclarations,
  type RawFactDeclaration,
} from '@shared/fact-registry';

/**
 * Client-side validation wrapper — calls the same browser-safe
 * `validateFactDeclarations` the server uses, so parity is guaranteed by
 * construction.
 */
export function validateFactsForSave(rows: RawFactDeclaration[]): string[] {
  return validateFactDeclarations(rows);
}

/**
 * Build the POST /api/config/statuses payload for a facts-only save.
 * Omits statuses/order/transitions so the server defaults them from the
 * current config (AC6 regression guard).
 */
export function buildFactsSavePayload(
  rows: RawFactDeclaration[],
  acks?: string[],
): { facts: RawFactDeclaration[]; factRemovalAcks?: string[] } {
  const payload: { facts: RawFactDeclaration[]; factRemovalAcks?: string[] } = {
    facts: rows,
  };
  if (acks && acks.length > 0) {
    payload.factRemovalAcks = acks;
  }
  return payload;
}

function countProblems(problems: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const p of problems) {
    counts.set(p, (counts.get(p) ?? 0) + 1);
  }
  return counts;
}

/**
 * Map each row to its first validation problem, if any.
 * Uses a prefix-differential approach: a problem is attributed to row `i`
 * when it first appears in `validateFactDeclarations(rows.slice(0, i+1))`.
 * Handles duplicates and cross-row collisions correctly (O(n²) but n is
 * tiny — typically < 20 facts).
 */
export function flagInvalidRows(rows: RawFactDeclaration[]): Map<number, string> {
  const result = new Map<number, string>();
  for (let i = 0; i < rows.length; i++) {
    const prevCounts = countProblems(validateFactDeclarations(rows.slice(0, i)));
    const currCounts = countProblems(validateFactDeclarations(rows.slice(0, i + 1)));
    for (const [problem, currCount] of currCounts.entries()) {
      const prevCount = prevCounts.get(problem) ?? 0;
      if (currCount > prevCount) {
        result.set(i, problem);
        break;
      }
    }
  }
  return result;
}

/**
 * Compute which fact names have been removed between the current saved
 * rows and the edited rows. Used to drive the 409 ack flow.
 */
export function computeRemovedFactNames(
  savedRows: RawFactDeclaration[],
  currentRows: RawFactDeclaration[],
): string[] {
  const currentNames = new Set(currentRows.map((r) => r.name));
  const removed: string[] = [];
  for (const row of savedRows) {
    if (!currentNames.has(row.name)) {
      removed.push(row.name);
    }
  }
  return removed;
}
