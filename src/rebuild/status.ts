import type {
  MissionData,
  ComputedStatus,
  MissionStatusValue,
  StatusCounts,
  NeedsAttention,
} from './types.js';

/**
 * Compute status counts from assignment statuses.
 */
export function computeStatusCounts(
  assignments: Array<{ status: string }>,
): StatusCounts {
  const counts: StatusCounts = {
    total: assignments.length,
    pending: 0,
    in_progress: 0,
    blocked: 0,
    review: 0,
    completed: 0,
    failed: 0,
  };
  for (const a of assignments) {
    const s = a.status as keyof Omit<StatusCounts, 'total'>;
    if (s in counts && s !== 'total') {
      (counts as Record<string, number>)[s]++;
    }
  }
  return counts;
}

/**
 * Compute needs-attention metrics from assignment data.
 */
export function computeNeedsAttention(
  assignments: Array<{
    status: string;
    unansweredQuestions: number;
  }>,
): NeedsAttention {
  let blockedCount = 0;
  let failedCount = 0;
  let unansweredQuestions = 0;
  for (const a of assignments) {
    if (a.status === 'blocked') blockedCount++;
    if (a.status === 'failed') failedCount++;
    unansweredQuestions += a.unansweredQuestions;
  }
  return { blockedCount, failedCount, unansweredQuestions };
}

/**
 * Compute the mission status using the 7-rule first-match-wins algorithm.
 *
 * Rules (from docs/protocol/file-formats.md lines 730-741):
 *   1. mission.md has archived: true        -> "archived"
 *   2. ALL assignments are completed         -> "completed"
 *   3. ANY assignment is in_progress/review  -> "active"
 *   4. ANY assignment is failed              -> "failed"
 *   5. ANY assignment is blocked             -> "blocked"
 *   6. ALL assignments are pending           -> "pending"
 *   7. Otherwise                             -> "active"
 */
export function computeMissionStatus(
  data: MissionData,
): MissionStatusValue {
  // Rule 1: archived override
  if (data.archived) return 'archived';

  const statuses = data.assignments.map((a) => a.status);

  // Edge case: no assignments — treat as pending
  if (statuses.length === 0) return 'pending';

  // Rule 2: ALL completed
  if (statuses.every((s) => s === 'completed')) return 'completed';

  // Rule 3: ANY in_progress or review
  if (statuses.some((s) => s === 'in_progress' || s === 'review'))
    return 'active';

  // Rule 4: ANY failed
  if (statuses.some((s) => s === 'failed')) return 'failed';

  // Rule 5: ANY blocked
  if (statuses.some((s) => s === 'blocked')) return 'blocked';

  // Rule 6: ALL pending
  if (statuses.every((s) => s === 'pending')) return 'pending';

  // Rule 7: Otherwise (mixed pending + completed, no active/failed/blocked)
  return 'active';
}

/**
 * Compute the full status result for a mission.
 */
export function computeStatus(data: MissionData): ComputedStatus {
  return {
    status: computeMissionStatus(data),
    progress: computeStatusCounts(data.assignments),
    needsAttention: computeNeedsAttention(data.assignments),
  };
}
