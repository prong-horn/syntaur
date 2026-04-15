import type { AssignmentDetail, AssignmentTransitionAction } from '../hooks/useMissions';

interface TransitionResponse {
  assignment: AssignmentDetail;
}

export async function runAssignmentTransition(
  missionSlug: string,
  assignmentSlug: string,
  action: AssignmentTransitionAction,
  reason?: string,
): Promise<AssignmentDetail> {
  const response = await fetch(
    `/api/missions/${missionSlug}/assignments/${assignmentSlug}/transitions/${action.command}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(reason ? { reason } : {}),
    },
  );

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(payload?.error || `HTTP ${response.status}`);
  }

  return (payload as TransitionResponse).assignment;
}

export async function overrideAssignmentStatus(
  missionSlug: string,
  assignmentSlug: string,
  status: string,
): Promise<AssignmentDetail> {
  const response = await fetch(
    `/api/missions/${missionSlug}/assignments/${assignmentSlug}/status-override`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    },
  );

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(payload?.error || `HTTP ${response.status}`);
  }

  return (payload as { assignment: AssignmentDetail }).assignment;
}

export async function deleteAssignment(
  missionSlug: string,
  assignmentSlug: string,
): Promise<void> {
  const response = await fetch(
    `/api/missions/${missionSlug}/assignments/${assignmentSlug}`,
    { method: 'DELETE' },
  );

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(payload?.error || `HTTP ${response.status}`);
  }
}

export function transitionNeedsReason(action: AssignmentTransitionAction): boolean {
  return action.requiresReason || action.command === 'block';
}
