import { runTransition, reportResult, type LifecycleOptions } from './_lifecycle-helper.js';

export interface PlanReadyOptions extends LifecycleOptions {
  agent?: string;
}

export async function planReadyCommand(
  assignment: string,
  options: PlanReadyOptions,
): Promise<void> {
  const result = await runTransition(assignment, 'plan-ready', options);
  reportResult(result);
}
