import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StageHandoffDescriptor } from '../useProjects';
import { stageDispatchActions } from '../useStageDispatch';
import { StageDispatchController } from '../../lib/stage-dispatch-controller';

const descriptor: StageHandoffDescriptor = {
  entryId: 'entry-1',
  stage: 'in_progress',
  role: 'agent',
  defaultAgentId: 'cursor',
  startDefaultAgentId: 'cursor',
  startDefaultAuto: true,
  auto: true,
  templateAuto: true,
  recordedTargetId: 'cursor',
  canDispatch: true,
  manualFallback: false,
};

/**
 * useStageDispatch is a thin binding (useMemo controller per ticket,
 * start/stop effect, sync effect, websocket forward, useSyncExternalStore).
 * These tests cover the exported actions mapping it returns, against a real
 * controller.
 */
describe('stageDispatchActions binding', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('routes actions to the controller and reflects its state', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            requestId: 'auto~entry-1',
            entryId: 'entry-1',
            agentId: 'cursor',
            stage: 'in_progress',
            state: 'queued',
          }),
          { status: 202 },
        ),
    );
    const controller = new StageDispatchController({
      ticketId: 'T-1',
      onTicketRefetch: () => {},
      fetchImpl: fetchImpl as unknown as typeof fetch,
      mintUuid: () => 'unused',
    });
    controller.start();
    controller.sync(descriptor);

    let actions = stageDispatchActions(controller, controller.getState(), descriptor);
    expect(actions.handOffSource).toBe('automatic');
    expect(actions.clientState).toBe('idle');

    const listener = vi.fn();
    const unsubscribe = controller.subscribe(listener);
    await actions.handOff();
    expect(listener).toHaveBeenCalled();
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    actions = stageDispatchActions(controller, controller.getState(), descriptor);
    expect(actions.clientState).toBe('queued');
    expect(actions.activeRequestId).toBe('auto~entry-1');
    expect(actions.disabledReason).toBe('Handoff queued');

    actions.setSelectedAgentId('reviewer');
    expect(controller.getState().selectedAgentId).toBe('reviewer');

    unsubscribe();
    controller.stop();
  });

  it('keeps the snapshot reference stable when nothing changes', () => {
    const controller = new StageDispatchController({
      ticketId: 'T-1',
      onTicketRefetch: () => {},
      fetchImpl: vi.fn() as unknown as typeof fetch,
    });
    controller.sync(descriptor);
    const before = controller.getState();
    controller.sync(descriptor);
    expect(controller.getState()).toBe(before);
  });
});
