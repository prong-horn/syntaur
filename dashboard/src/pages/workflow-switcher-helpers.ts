// Kept React-free (no hook import) so it unit-tests under the node vitest config.

/** The base path for a workflow's status-config routes (GET/POST/DELETE). The
 * built-in `default` keeps the legacy `/api/config/statuses` path; others use
 * `/api/config/workflows/:id`. */
export function workflowApiBase(workflowId: string): string {
  return workflowId === 'default'
    ? '/api/config/statuses'
    : `/api/config/workflows/${encodeURIComponent(workflowId)}`;
}

/** The `/affected/:statusId` endpoint for a workflow (used by the remap flow when
 * a status with assignments is dropped). */
export function affectedEndpoint(workflowId: string, statusId: string): string {
  return `${workflowApiBase(workflowId)}/affected/${encodeURIComponent(statusId)}`;
}

/** Validate a proposed new/duplicate workflow id. Returns an error message, or
 * null when the id is acceptable. Mirrors the server's isValidWorkflowId. */
export function validateNewWorkflowId(id: string, existingIds: string[]): string | null {
  const trimmed = id.trim();
  if (trimmed.length === 0) return 'Enter a workflow id.';
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(trimmed)) {
    return 'Use letters, digits, "_" or "-" (must start with a letter or digit).';
  }
  if (trimmed.length > 64) return 'Too long (max 64 characters).';
  if (existingIds.includes(trimmed)) return `Workflow "${trimmed}" already exists.`;
  return null;
}

/** The built-in `default` workflow can never be deleted (it resets instead). */
export function canDeleteWorkflow(workflowId: string): boolean {
  return workflowId !== 'default';
}

/** Which workflow the switcher should select after the current one is deleted —
 * prefer the global default, else the first remaining, else `default`. */
export function nextWorkflowAfterDelete(
  deletedId: string,
  allIds: string[],
  defaultWorkflow: string,
): string {
  const remaining = allIds.filter((id) => id !== deletedId);
  if (remaining.length === 0) return 'default';
  if (remaining.includes(defaultWorkflow)) return defaultWorkflow;
  return remaining[0];
}
