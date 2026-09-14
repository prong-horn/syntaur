import type { StageId } from './manifest.js';

/** Global stage order (§3.5). `dropped` is terminal but not declared in templates. */
export const STAGE_ORDER: readonly (StageId | 'dropped')[] = [
  'backlog',
  'planning',
  'ready',
  'in_progress',
  'review',
  'done',
  'dropped',
];

const STATUS_TO_STAGE: Record<string, StageId | 'dropped'> = {
  draft: 'backlog',
  pending: 'backlog',
  ready_for_planning: 'planning',
  ready_to_implement: 'ready',
  in_progress: 'in_progress',
  blocked: 'in_progress',
  review: 'review',
  completed: 'done',
  failed: 'dropped',
};

/** Map a v1 ticket status to the template stage id. */
export function stageForStatus(status: string): StageId | 'dropped' {
  return STATUS_TO_STAGE[status] ?? 'backlog';
}

export function stageIndex(stage: StageId | 'dropped'): number {
  return STAGE_ORDER.indexOf(stage);
}

/** True when `candidate` is at or before `current` in global stage order. */
export function stageAtOrBefore(
  candidate: StageId,
  current: StageId | 'dropped',
): boolean {
  const ci = stageIndex(current);
  const ti = stageIndex(candidate);
  if (ci < 0 || ti < 0) return false;
  return ti <= ci;
}
