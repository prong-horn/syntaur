import { unblockFactCommand, type DeriveVerbOptions } from './derive-verbs.js';

/** Derived model: clears blockedReason; status re-derives to wherever the
 * facts actually are (not an imperative jump to in_progress). */
export async function unblockCommand(ticket: string, options: DeriveVerbOptions): Promise<void> {
  await unblockFactCommand(ticket, options);
}
