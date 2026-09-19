import { describe, expect, it } from 'vitest';
import { getTicketAction } from '../useBoardActions';
import type { TicketBoardItem } from '../../data/types';

describe('useBoardActions helpers', () => {
  it('surfaces disabled verb as the drag refusal path', () => {
    const item: TicketBoardItem = {
      id: '1',
      slug: 't',
      title: 'T',
      status: 'in_progress',
      template: null,
      statusLabel: 'In progress',
      priority: 'medium',
      assignee: null,
      depends_on: [],
      links: [],
      tags: [],
      blocked: null,
      parked: null,
      created: '',
      updated: '',
      completedAt: null,
      statusAge: null,
      projectSlug: 'p',
      projectTitle: 'P',
      availableVerbs: [
        {
          command: 'done',
          label: 'Done',
          description: 'Mark done',
          targetStatus: 'done',
          disabled: true,
          disabledReason: 'Lifecycle gate',
          warning: null,
          requiresReason: false,
        },
      ],
    };
    const action = getTicketAction(item, 'done');
    expect(action?.disabled).toBe(true);
    expect(action?.disabledReason).toBe('Lifecycle gate');
  });
});
