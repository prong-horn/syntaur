import { runUnassign, reportResult, type LifecycleOptions } from './_lifecycle-helper.js';

export type UnassignOptions = LifecycleOptions;

export async function unassignCommand(
  assignment: string,
  options: UnassignOptions,
): Promise<void> {
  const result = await runUnassign(assignment, options);
  reportResult(result);
}
