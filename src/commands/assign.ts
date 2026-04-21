import { runAssign, reportResult, type LifecycleOptions } from './_lifecycle-helper.js';

export interface AssignOptions extends LifecycleOptions {
  agent: string;
}

export async function assignCommand(
  assignment: string,
  options: AssignOptions,
): Promise<void> {
  if (!options.agent) {
    throw new Error('--agent <name> is required.');
  }
  const result = await runAssign(assignment, options.agent, options);
  reportResult(result);
}
