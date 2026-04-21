import { runTransition, reportResult, type LifecycleOptions } from './_lifecycle-helper.js';

export interface StartOptions extends LifecycleOptions {
  agent?: string;
}

export async function startCommand(
  assignment: string,
  options: StartOptions,
): Promise<void> {
  const result = await runTransition(assignment, 'start', options);
  reportResult(result);
}
