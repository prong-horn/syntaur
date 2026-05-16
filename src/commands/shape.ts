import { runTransition, reportResult, type LifecycleOptions } from './_lifecycle-helper.js';

export interface ShapeOptions extends LifecycleOptions {
  agent?: string;
}

export async function shapeCommand(
  assignment: string,
  options: ShapeOptions,
): Promise<void> {
  const result = await runTransition(assignment, 'shape', options);
  reportResult(result);
}
