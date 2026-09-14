import type { TicketTransitionAction } from '../hooks/useProjects';

export interface DropValidation {
  allowed: boolean;
  reason?: string;
}

/** Decision 9: a kanban drop is allowed only when a verb reaches the target stage. */
export function validateStageColumnDrop(params: {
  fromColumnId: string;
  toColumnId: string;
  action: TicketTransitionAction | undefined;
}): DropValidation {
  if (params.fromColumnId === params.toColumnId) {
    return { allowed: true };
  }

  const { action } = params;
  if (!action) {
    return { allowed: false, reason: 'No verb reaches that stage from here.' };
  }
  if (action.disabled) {
    return { allowed: false, reason: action.disabledReason || action.description };
  }

  return { allowed: true, reason: action.warning || action.description };
}
