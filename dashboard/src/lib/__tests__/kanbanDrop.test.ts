import { describe, expect, it } from 'vitest';
import { validateStageColumnDrop } from '../kanbanDrop';
import type { TicketTransitionAction } from '../../hooks/useProjects';

function planVerb(): TicketTransitionAction {
  return {
    command: 'plan',
    label: 'Plan',
    targetStatus: 'planning',
    description: 'Move to planning',
    disabled: false,
    disabledReason: null,
    warning: null,
    requiresReason: false,
  };
}

describe('validateStageColumnDrop', () => {
  it('refuses backlog → done when no verb reaches done', () => {
    const result = validateStageColumnDrop({
      fromColumnId: 'backlog',
      toColumnId: 'done',
      action: undefined,
    });
    expect(result).toEqual({
      allowed: false,
      reason: 'No verb reaches that stage from here.',
    });
  });

  it('allows backlog → planning via the plan verb', () => {
    const result = validateStageColumnDrop({
      fromColumnId: 'backlog',
      toColumnId: 'planning',
      action: planVerb(),
    });
    expect(result.allowed).toBe(true);
    expect(result.reason).toBe('Move to planning');
  });
});
