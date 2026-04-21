import { runTransition, reportResult, type LifecycleOptions } from './_lifecycle-helper.js';

export interface UnblockOptions extends LifecycleOptions {}

export async function unblockCommand(
  assignment: string,
  options: UnblockOptions,
): Promise<void> {
  const result = await runTransition(assignment, 'unblock', options);
  reportResult(result);
}
