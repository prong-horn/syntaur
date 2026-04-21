import { runTransition, reportResult, type LifecycleOptions } from './_lifecycle-helper.js';

export interface CompleteOptions extends LifecycleOptions {}

export async function completeCommand(
  assignment: string,
  options: CompleteOptions,
): Promise<void> {
  const result = await runTransition(assignment, 'complete', options);
  reportResult(result);
}
