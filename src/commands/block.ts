import { runTransition, reportResult, type LifecycleOptions } from './_lifecycle-helper.js';

export interface BlockOptions extends LifecycleOptions {
  reason?: string;
}

export async function blockCommand(
  assignment: string,
  options: BlockOptions,
): Promise<void> {
  const result = await runTransition(assignment, 'block', options);
  reportResult(result);
}
