import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { TicketPage } from '../TicketPage';
import { ResourceProvider } from '../../data/useResource';
import { resources, apiUrl } from '../../data/resources';
import type { TicketDetail } from '../../data/types';
import type { StageDispatchActions } from '../../hooks/useStageDispatch';

vi.mock('../../components/chat/ChatTab', () => ({
  ChatTab: () => createElement('div', null, 'Chat tab panel'),
}));

vi.mock('../../hooks/useStageDispatch', () => ({
  useStageDispatch: (): StageDispatchActions => ({
    selectedAgentId: null,
    setSelectedAgentId: () => {},
    clientState: 'idle',
    activeRequestId: null,
    receipt: null,
    staleMessage: null,
    errorMessage: null,
    busy: false,
    disabledReason: null,
    handOffSource: null,
    handOff: async () => {},
    retry: async () => {},
    cancel: async () => {},
    clearStale: () => {},
  }),
}));

function minimalTicket(overrides: Partial<TicketDetail> = {}): TicketDetail {
  return {
    id: 'T-1',
    slug: 'task',
    title: 'Fix inbox',
    status: 'in_progress',
    template: 'feature',
    statusLabel: 'In progress',
    priority: 'medium',
    assignee: null,
    depends_on: [],
    body: '## Acceptance Criteria\n- [ ] Ship',
    blocked: null,
    parked: null,
    next: 'Finish tests',
    created: '2026-01-01T00:00:00Z',
    updated: '2026-01-02T00:00:00Z',
    projectSlug: 'demo',
    availableVerbs: [
      {
        command: 'review',
        label: 'Send to review',
        description: 'Move to review',
        targetStatus: 'review',
        disabled: false,
        disabledReason: null,
        warning: null,
        requiresReason: false,
      },
    ],
    workspace: { repository: null, worktree: null, branch: null, parentBranch: null },
    templateBlock: {
      id: 'feature',
      files: [
        {
          path: 'journal.md',
          role: 'log',
          writer: 'cli',
          description: 'Journal',
          state: '1 entry',
          exists: true,
          createOn: 'ticket-creation',
          body: null,
          entryTypes: ['progress', 'note'],
          logEntries: [],
        },
      ],
    },
    engagements: [],
    enrichedLinks: [],
    referencedBy: [],
    metrics: { costUsd: 1.25, sessionCount: 2, costSource: 'usage', partial: false },
    stageHandoff: {
      entryId: 'e1',
      stage: 'implement',
      role: 'agent',
      defaultAgentId: 'cursor',
      startDefaultAgentId: 'cursor',
      startDefaultAuto: true,
      auto: true,
      templateAuto: true,
      recordedTargetId: 'cursor',
      canDispatch: true,
      manualFallback: false,
    },
    plan: null,
    scratchpad: null,
    ...overrides,
  } as TicketDetail;
}

function renderTicket(path: string, ticket: TicketDetail = minimalTicket()) {
  const editUrl = apiUrl(['tickets', 'T-1', 'edit']);
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={[path]}>
      <ResourceProvider
        seed={[
          [resources.ticket('T-1'), ticket],
          [resources.project('demo'), { slug: 'demo', title: 'Demo', tickets: [] }],
          [resources.ticketEvents('T-1'), { events: [] }],
          [resources.ticketSessions('T-1'), { sessions: [] }],
          [
            resources.ticketUsage('T-1'),
            {
              summary: {
                totalTokens: 0,
                totalCost: 0,
                lastEventDay: null,
                byModel: [],
                lifetime: ticket.metrics,
              },
            },
          ],
          [resources.document(editUrl), { content: '# Ticket body', path: 'ticket.md' }],
        ]}
      >
        <Routes>
          <Route path="/t/:id" element={<TicketPage />} />
        </Routes>
      </ResourceProvider>
    </MemoryRouter>,
  );
}

describe('TicketPage SSR through seeded resources', () => {
  it('renders header metrics from the ticket payload', () => {
    const html = renderTicket('/t/T-1');
    expect(html).toContain('Fix inbox');
    expect(html).toContain('data-testid="ticket-metrics"');
    expect(html).toContain('$1.25');
    expect(html).toContain('2 sessions');
  });

  it('opens the shared ticket editor when ?edit=ticket is present', () => {
    const html = renderTicket('/t/T-1?edit=ticket');
    expect(html).toContain('Edit Ticket');
    expect(html).toContain('Edit ticket fields');
  });

  it('preserves the tab/hash contract on the chat tab', () => {
    const html = renderTicket('/t/T-1?tab=chat#item-1');
    expect(html).toContain('Chat tab panel');
  });
});
