import { runTransition, reportResult, type LifecycleOptions } from './_lifecycle-helper.js';

export interface ReviewOptions extends LifecycleOptions {}

export async function reviewCommand(
  assignment: string,
  options: ReviewOptions,
): Promise<void> {
  const result = await runTransition(assignment, 'review', options);
  reportResult(result);
}
