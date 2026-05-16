import { runTransition, reportResult, type LifecycleOptions } from './_lifecycle-helper.js';

export interface ImplementOptions extends LifecycleOptions {
  agent?: string;
}

export async function implementCommand(
  assignment: string,
  options: ImplementOptions,
): Promise<void> {
  const result = await runTransition(assignment, 'implement', options);
  reportResult(result);
}
