import type { AssignmentDetail, AssignmentTransitionAction } from '../hooks/useProjects';

interface TransitionResponse {
  assignment: AssignmentDetail;
}

export async function runAssignmentTransition(
  projectSlug: string,
  assignmentSlug: string,
  action: AssignmentTransitionAction,
  reason?: string,
): Promise<AssignmentDetail> {
  const response = await fetch(
    `/api/projects/${projectSlug}/assignments/${assignmentSlug}/transitions/${action.command}`,
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
  projectSlug: string,
  assignmentSlug: string,
  status: string,
): Promise<AssignmentDetail> {
  const response = await fetch(
    `/api/projects/${projectSlug}/assignments/${assignmentSlug}/status-override`,
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
  projectSlug: string,
  assignmentSlug: string,
): Promise<void> {
  const response = await fetch(
    `/api/projects/${projectSlug}/assignments/${assignmentSlug}`,
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

export async function runAssignmentTransitionById(
  id: string,
  action: AssignmentTransitionAction,
  reason?: string,
): Promise<AssignmentDetail> {
  const response = await fetch(
    `/api/assignments/${id}/transitions/${action.command}`,
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

export async function overrideAssignmentStatusById(
  id: string,
  status: string,
): Promise<AssignmentDetail> {
  const response = await fetch(
    `/api/assignments/${id}/status-override`,
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

// --- Overview quick-action helpers ---

export interface BulkAssignmentActionItem {
  projectSlug?: string | null;
  assignmentSlug?: string;
  id?: string;
  status: string;
}

export interface BulkAssignmentActionResult {
  results: Array<{ key: string; ok: boolean; error?: string }>;
  succeeded: number;
  failed: number;
}

/**
 * POST /api/assignments/bulk-status-override. Used by the Overview Stale
 * segment for bulk-archive (and other future bulk status flips).
 */
export async function runBulkAssignmentAction(
  items: BulkAssignmentActionItem[],
  reason?: string,
): Promise<BulkAssignmentActionResult> {
  const response = await fetch('/api/assignments/bulk-status-override', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(reason ? { items, reason } : { items }),
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error((payload as { error?: string } | null)?.error || `HTTP ${response.status}`);
  }
  return payload as BulkAssignmentActionResult;
}

/**
 * Set the assignee on a project-scoped assignment via the dedicated
 * assignee endpoint. Body content stays untouched — only the
 * frontmatter `assignee:` field changes.
 */
export async function claimAssignment(args: {
  projectSlug: string;
  assignmentSlug: string;
  assignee: string | null;
}): Promise<AssignmentDetail> {
  const response = await fetch(
    `/api/projects/${args.projectSlug}/assignments/${args.assignmentSlug}/assignee`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ assignee: args.assignee }),
    },
  );
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error((payload as { error?: string } | null)?.error || `HTTP ${response.status}`);
  }
  return (payload as { assignment: AssignmentDetail }).assignment;
}

/** Standalone-assignment variant of {@link claimAssignment}. */
export async function claimAssignmentById(args: {
  id: string;
  assignee: string | null;
}): Promise<AssignmentDetail> {
  const response = await fetch(`/api/assignments/${args.id}/assignee`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ assignee: args.assignee }),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error((payload as { error?: string } | null)?.error || `HTTP ${response.status}`);
  }
  return (payload as { assignment: AssignmentDetail }).assignment;
}

export type QuickCommentType = 'question' | 'note' | 'feedback';

/**
 * Post a single quick comment to a project-scoped or standalone
 * assignment. Wraps the existing /comments endpoints.
 */
export async function postQuickComment(args: {
  projectSlug: string | null;
  assignmentSlug?: string;
  id?: string;
  body: string;
  type?: QuickCommentType;
  author?: string;
}): Promise<void> {
  let url: string;
  if (args.projectSlug && args.assignmentSlug) {
    url = `/api/projects/${args.projectSlug}/assignments/${args.assignmentSlug}/comments`;
  } else if (args.id) {
    url = `/api/assignments/${args.id}/comments`;
  } else {
    throw new Error('postQuickComment requires either (projectSlug + assignmentSlug) or id');
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      body: args.body,
      type: args.type ?? 'note',
      author: args.author,
    }),
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error((payload as { error?: string } | null)?.error || `HTTP ${response.status}`);
  }
}

/**
 * Read/write the dashboard-side "claim as" identity used by
 * {@link claimAssignment}. There is no "current agent" in the browser, so we
 * persist the user's preferred value in localStorage with `'human'` as
 * default. The first-use flow opens a dialog; subsequent claims are
 * one-click. Hold Shift on the claim button to re-open the dialog.
 */
const CLAIM_AS_STORAGE_KEY = 'syntaur:dashboard:claimAs';
const CLAIM_AS_DEFAULT = 'human';

export function readClaimAs(): string {
  try {
    const stored = window.localStorage.getItem(CLAIM_AS_STORAGE_KEY);
    if (stored && stored.trim().length > 0) return stored.trim();
  } catch {
    // ignore — storage may be unavailable (private mode, etc.)
  }
  return CLAIM_AS_DEFAULT;
}

export function writeClaimAs(value: string | null): void {
  try {
    if (value === null || value.trim().length === 0) {
      window.localStorage.removeItem(CLAIM_AS_STORAGE_KEY);
    } else {
      window.localStorage.setItem(CLAIM_AS_STORAGE_KEY, value.trim());
    }
  } catch {
    // ignore
  }
}

export function hasStoredClaimAs(): boolean {
  try {
    const stored = window.localStorage.getItem(CLAIM_AS_STORAGE_KEY);
    return Boolean(stored && stored.trim().length > 0);
  } catch {
    return false;
  }
}
