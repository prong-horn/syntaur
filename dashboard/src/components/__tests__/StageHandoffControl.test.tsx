import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { StageHandoffControl } from '../StageHandoffControl';
import type { StageHandoffDescriptor } from '../../hooks/useProjects';
import type { StageDispatchActions } from '../../hooks/useStageDispatch';

const descriptor: StageHandoffDescriptor = {
  entryId: 'entry-1',
  stage: 'in_progress',
  role: 'agent',
  defaultAgentId: 'cursor',
  startDefaultAgentId: 'cursor',
  startDefaultAuto: true,
  auto: false,
  templateAuto: false,
  recordedTargetId: 'cursor',
  canDispatch: true,
  manualFallback: false,
};

function dispatchStub(overrides: Partial<StageDispatchActions> = {}): StageDispatchActions {
  return {
    selectedAgentId: null,
    setSelectedAgentId: () => {},
    clientState: 'idle',
    activeRequestId: null,
    receipt: null,
    staleMessage: null,
    errorMessage: null,
    busy: false,
    disabledReason: null,
    handOffSource: 'manual',
    handOff: async () => {},
    retry: async () => {},
    cancel: async () => {},
    clearStale: () => {},
    ...overrides,
  };
}

describe('StageHandoffControl', () => {
  it('renders handoff action for manual stages', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <StageHandoffControl ticketId="T-1" descriptor={descriptor} dispatch={dispatchStub()} />
      </MemoryRouter>,
    );
    expect(html).toContain('Hand to @cursor');
    expect(html).toContain('View chat');
  });

  it('shows running status and cancel affordance', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <StageHandoffControl
          ticketId="T-1"
          descriptor={descriptor}
          dispatch={dispatchStub({
            clientState: 'running',
            receipt: {
              requestId: 'req-1',
              entryId: 'entry-1',
              agentId: 'cursor',
              stage: 'in_progress',
              state: 'running',
            },
          })}
        />
      </MemoryRouter>,
    );
    expect(html).toContain('Handoff running');
    expect(html).toContain('Cancel');
  });

  it('hides on terminal done stages', () => {
    const html = renderToStaticMarkup(
      <StageHandoffControl
        ticketId="T-1"
        descriptor={{
          ...descriptor,
          stage: 'done',
          canDispatch: false,
          reason: 'Terminal stages do not accept stage handoffs',
        }}
        dispatch={dispatchStub()}
      />,
    );
    expect(html).toBe('');
  });

  it('disables handoff while resolving unknown acceptance', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <StageHandoffControl
          ticketId="T-1"
          descriptor={descriptor}
          dispatch={dispatchStub({
            clientState: 'unknown',
            activeRequestId: 'auto~entry-1',
            disabledReason: 'Resolving prior handoff acceptance…',
          })}
        />
      </MemoryRouter>,
    );
    expect(html).toContain('Retry lookup');
    expect(html).toContain('disabled');
    expect(html).not.toContain('Hand to @cursor');
  });

  it('shows stale entry explanation and failed receipt state', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <StageHandoffControl
          ticketId="T-1"
          descriptor={descriptor}
          dispatch={dispatchStub({
            clientState: 'failed',
            staleMessage: 'Stale stage entry',
            receipt: {
              requestId: 'manual-1',
              entryId: 'old-entry',
              agentId: 'cursor',
              stage: 'in_progress',
              state: 'failed',
              error: 'target disabled',
            },
          })}
        />
      </MemoryRouter>,
    );
    expect(html).toContain('Stale stage entry');
    expect(html).toContain('failed');
    expect(html).toContain('target disabled');
  });

  it('requires manual agent selection when no template default exists', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <StageHandoffControl
          ticketId="T-1"
          descriptor={{ ...descriptor, defaultAgentId: null, auto: false }}
          dispatch={dispatchStub()}
        />
      </MemoryRouter>,
    );
    expect(html).toContain('Select agent');
    expect(html).not.toContain('Hand to @');
  });

  it('shows completed turn without implying ticket done', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <StageHandoffControl
          ticketId="T-1"
          descriptor={descriptor}
          dispatch={dispatchStub({
            clientState: 'completed',
            receipt: {
              requestId: 'manual-1',
              entryId: 'entry-1',
              agentId: 'cursor',
              stage: 'in_progress',
              state: 'completed',
            },
          })}
        />
      </MemoryRouter>,
    );
    expect(html).toContain('ticket not done');
    expect(html).toContain('Hand to again');
  });

  it('hides the picker for automatic hand-offs to the recorded target', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <StageHandoffControl
          ticketId="T-1"
          descriptor={{ ...descriptor, auto: true }}
          dispatch={dispatchStub({ handOffSource: 'automatic', selectedAgentId: 'reviewer' })}
        />
      </MemoryRouter>,
    );
    expect(html).not.toContain('Handoff agent');
    expect(html).toContain('Hand to @cursor');
    expect(html).not.toContain('@reviewer');
  });

  it('labels an automatic hand-off with the recorded target, not the template default', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <StageHandoffControl
          ticketId="T-1"
          descriptor={{ ...descriptor, auto: true, templateAuto: true, recordedTargetId: 'codex' }}
          dispatch={dispatchStub({ handOffSource: 'automatic' })}
        />
      </MemoryRouter>,
    );
    expect(html).toContain('Hand to @codex');
    expect(html).not.toContain('Hand to @cursor');
  });

  it('labels an override entry on an auto:false stage with the recorded target', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <StageHandoffControl
          ticketId="T-1"
          descriptor={{ ...descriptor, auto: true, templateAuto: false, recordedTargetId: 'codex' }}
          dispatch={dispatchStub({ handOffSource: 'automatic' })}
        />
      </MemoryRouter>,
    );
    expect(html).not.toContain('Handoff agent');
    expect(html).toContain('Hand to @codex');
  });

  it('keeps the template default for manual hand-offs on fallback entries', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <StageHandoffControl
          ticketId="T-1"
          descriptor={{
            ...descriptor,
            entryId: 'unrecorded~in_progress~abc',
            manualFallback: true,
            auto: false,
            templateAuto: true,
            recordedTargetId: null,
          }}
          dispatch={dispatchStub({ handOffSource: 'manual' })}
        />
      </MemoryRouter>,
    );
    expect(html).toContain('Handoff agent');
    expect(html).toContain('Hand to @cursor');
  });

  it('labels an automatic hand-off without a recorded target as the recorded agent', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <StageHandoffControl
          ticketId="T-1"
          descriptor={{ ...descriptor, auto: true, defaultAgentId: null, recordedTargetId: null }}
          dispatch={dispatchStub({ handOffSource: 'automatic' })}
        />
      </MemoryRouter>,
    );
    expect(html).not.toContain('Select agent');
    expect(html).toContain('Hand to recorded agent');
  });

  it('offers the picker for a new manual attempt after a terminal receipt on an auto stage', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <StageHandoffControl
          ticketId="T-1"
          descriptor={{ ...descriptor, auto: true }}
          dispatch={dispatchStub({
            handOffSource: 'manual',
            clientState: 'failed',
            receipt: {
              requestId: 'auto~entry-1',
              entryId: 'entry-1',
              agentId: 'cursor',
              stage: 'in_progress',
              state: 'failed',
            },
          })}
        />
      </MemoryRouter>,
    );
    expect(html).toContain('Handoff agent');
    expect(html).toContain('Hand to again');
  });

  it('hides Hand to again when the server descriptor cannot dispatch', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <StageHandoffControl
          ticketId="T-1"
          descriptor={{ ...descriptor, canDispatch: false, reason: 'Agent @cursor is disabled' }}
          dispatch={dispatchStub({
            clientState: 'completed',
            disabledReason: 'Agent @cursor is disabled',
            receipt: {
              requestId: 'manual-1',
              entryId: 'entry-1',
              agentId: 'cursor',
              stage: 'in_progress',
              state: 'completed',
            },
          })}
        />
      </MemoryRouter>,
    );
    expect(html).toContain('ticket not done');
    expect(html).not.toContain('Hand to again');
    expect(html).not.toContain('Hand to @cursor');
  });

  it('renders action errors inline', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <StageHandoffControl
          ticketId="T-1"
          descriptor={descriptor}
          dispatch={dispatchStub({ errorMessage: 'Broker unavailable' })}
        />
      </MemoryRouter>,
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain('Broker unavailable');
  });
});
