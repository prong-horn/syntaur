import { runTransition, reportResult, type LifecycleOptions } from './_lifecycle-helper.js';

export interface ReopenOptions extends LifecycleOptions {}

export async function reopenCommand(
  assignment: string,
  options: ReopenOptions,
): Promise<void> {
  const result = await runTransition(assignment, 'reopen', options);
  reportResult(result);
}
