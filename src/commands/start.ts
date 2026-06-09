import { implementStartedCommand, type DeriveVerbOptions } from './derive-verbs.js';

export interface StartOptions extends DeriveVerbOptions {
  agent?: string;
}

/** Derived model: `start` = `implement` — asserts implementationStarted.
 * The derived status reflects where the assignment actually is. */
export async function startCommand(assignment: string, options: StartOptions): Promise<void> {
  await implementStartedCommand(assignment, options);
}
