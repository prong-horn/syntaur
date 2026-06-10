import { recomputeCommand, type DeriveVerbOptions } from './derive-verbs.js';

/** Derived model: shaping IS filling in the objective/ACs — there's no fact
 * to assert. `shape` just recomputes; ready_for_planning follows when the
 * content is real (placeholder ACs don't count). */
export async function shapeCommand(assignment: string, options: DeriveVerbOptions): Promise<void> {
  await recomputeCommand(assignment, options);
}
