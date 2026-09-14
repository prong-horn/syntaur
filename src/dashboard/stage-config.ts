import {
  STAGE_ORDER,
  STAGE_LABELS,
  STAGE_COLORS,
  isTerminalStage,
} from '../ticket-templates/stages.js';
import type { StageId } from '../ticket-templates/manifest.js';

export interface StageDefinition {
  id: string;
  label: string;
  color: string;
  terminal?: boolean;
}

/** Fixed v2 stage table for dashboard surfaces (board columns, badges, pickers). */
export const STAGE_TABLE: StageDefinition[] = STAGE_ORDER.map((id) => ({
  id,
  label: STAGE_LABELS[id],
  color: STAGE_COLORS[id],
  ...(isTerminalStage(id) ? { terminal: true } : {}),
}));

export const STAGE_IDS = [...STAGE_ORDER] as const;

export const PROJECT_ROLLUP_STATUSES = [
  'pending',
  'active',
  'blocked',
  'completed',
  'failed',
] as const;

export type ProjectRollupStatus = (typeof PROJECT_ROLLUP_STATUSES)[number];

export function getStageLabel(stageId: string): string {
  const key = stageId as StageId | 'dropped';
  return STAGE_LABELS[key] ?? stageId.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

export function isTerminalStageId(stageId: string): boolean {
  try {
    return isTerminalStage(stageId as StageId | 'dropped');
  } catch {
    return stageId === 'done' || stageId === 'dropped';
  }
}
