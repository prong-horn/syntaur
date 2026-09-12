import { implementStartedCommand, type DeriveVerbOptions } from './derive-verbs.js';

export interface StartOptions extends DeriveVerbOptions {
  agent?: string;
}

/** Derived model: `start` = `implement` — asserts implementationStarted.
 * The derived status reflects where the ticket actually is. */
export async function startCommand(ticket: string, options: StartOptions): Promise<void> {
  await implementStartedCommand(ticket, options);
}
