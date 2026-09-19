import { renderToString } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { TicketBoardCard } from '../TicketBoardCard';
import type { TicketBoardItem } from '../../../data/types';

const ticket: TicketBoardItem = {
  id: 'ticket-uuid-12345678',
  slug: 'my-ticket',
  title: 'Example ticket',
  status: 'in_progress',
  template: 'feature',
  statusLabel: 'In progress',
  priority: 'high',
  assignee: 'agent',
  depends_on: ['dep-1'],
  links: [],
  tags: ['ui'],
  blocked: null,
  parked: null,
  created: '2026-01-01T00:00:00.000Z',
  updated: '2026-01-02T00:00:00.000Z',
  completedAt: null,
  statusAge: 1,
  projectSlug: 'proj',
  projectTitle: 'Project',
  availableVerbs: [],
  metrics: {
    costUsd: null,
    sessionCount: 2,
    costSource: 'none',
    partial: false,
  },
};

describe('TicketBoardCard', () => {
  it('renders metrics from the ticket payload', () => {
    const html = renderToString(
      <MemoryRouter>
        <TicketBoardCard ticket={ticket} />
      </MemoryRouter>,
    );
    expect(html).toContain('data-testid="ticket-metrics"');
    expect(html).toContain('2 sessions');
  });
});
