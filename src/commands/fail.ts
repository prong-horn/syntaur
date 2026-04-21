import { runTransition, reportResult, type LifecycleOptions } from './_lifecycle-helper.js';

export interface FailOptions extends LifecycleOptions {}

export async function failCommand(
  assignment: string,
  options: FailOptions,
): Promise<void> {
  const result = await runTransition(assignment, 'fail', options);
  reportResult(result);
}
