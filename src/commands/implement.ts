import { implementStartedCommand, type DeriveVerbOptions } from './derive-verbs.js';

export interface ImplementOptions extends DeriveVerbOptions {
  agent?: string;
}

/** Derived model: `implement` asserts implementationStarted; in_progress
 * follows from derivation when the plan is approved. */
export async function implementCommand(ticket: string, options: ImplementOptions): Promise<void> {
  await implementStartedCommand(ticket, options);
}
