import { blockFactCommand } from './derive-verbs.js';
import type { DeriveVerbOptions } from './derive-verbs.js';

export interface BlockOptions extends DeriveVerbOptions {
  reason?: string;
}

/** Derived model: `block` asserts the blockedReason FACT; the blocked status
 * follows from derivation (disposition rule) rather than an imperative write. */
export async function blockCommand(assignment: string, options: BlockOptions): Promise<void> {
  await blockFactCommand(assignment, options);
}
