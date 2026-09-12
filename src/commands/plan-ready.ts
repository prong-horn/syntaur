import { planApproveCommand, type DeriveVerbOptions } from './derive-verbs.js';

/** Derived model: `plan-ready` = approving the latest plan revision
 * (file+digest bound). ready_to_implement follows from derivation. */
export async function planReadyCommand(ticket: string, options: DeriveVerbOptions): Promise<void> {
  await planApproveCommand(ticket, options);
}
