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

/** v1 status → v2 stage id (migrator only). */
const LEGACY_STATUS_TO_STAGE: Record<string, StageId | 'dropped'> = {
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

/** Map a legacy v1 ticket status to the template stage id (migrator only). */
export function legacyStatusToStage(status: string): StageId | 'dropped' {
  if ((STAGE_ORDER as readonly string[]).includes(status)) {
    return status as StageId | 'dropped';
  }
  const mapped = LEGACY_STATUS_TO_STAGE[status];
  if (mapped) return mapped;
  return 'backlog';
}

/** Map a stored v2 stage id; throws on unknown values. */
export function stageForStatus(status: string): StageId | 'dropped' {
  if ((STAGE_ORDER as readonly string[]).includes(status)) {
    return status as StageId | 'dropped';
  }
  throw new Error(`unknown stage ${status}`);
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

export const STAGE_LABELS: Record<StageId | 'dropped', string> = {
  backlog: 'Backlog',
  planning: 'Planning',
  ready: 'Ready',
  in_progress: 'In Progress',
  review: 'Review',
  done: 'Done',
  dropped: 'Dropped',
};

export const STAGE_COLORS: Record<StageId | 'dropped', string> = {
  backlog: 'slate',
  planning: 'violet',
  ready: 'blue',
  in_progress: 'teal',
  review: 'amber',
  done: 'emerald',
  dropped: 'rose',
};

export const TERMINAL_STAGES: ReadonlySet<StageId | 'dropped'> = new Set(['done', 'dropped']);

export function isTerminalStage(stage: StageId | 'dropped'): boolean {
  return TERMINAL_STAGES.has(stage);
}
