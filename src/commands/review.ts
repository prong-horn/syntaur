import { requestReviewCommand, type DeriveVerbOptions } from './derive-verbs.js';

/** Derived model: `review` asserts reviewRequested; the review phase follows
 * from derivation (also satisfied by all ACs checked). */
export async function reviewCommand(ticket: string, options: DeriveVerbOptions): Promise<void> {
  await requestReviewCommand(ticket, options);
}
