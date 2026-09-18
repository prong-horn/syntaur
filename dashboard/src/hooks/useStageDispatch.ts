import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { useWebSocket } from './useWebSocket';
import type { StageHandoffDescriptor, StageHandoffReceiptSummary } from './useProjects';
import {
  StageDispatchController,
  primaryHandOffSource,
  stageDispatchDisabledReason,
  type StageDispatchClientState,
  type StageDispatchSource,
  type StageDispatchState,
} from '../lib/stage-dispatch-controller';

export type { StageDispatchClientState, StageDispatchSource };

export interface StageDispatchActions {
  selectedAgentId: string | null;
  setSelectedAgentId: (id: string | null) => void;
  clientState: StageDispatchClientState;
  activeRequestId: string | null;
  receipt: StageHandoffReceiptSummary | null;
  staleMessage: string | null;
  errorMessage: string | null;
  busy: boolean;
  disabledReason: string | null;
  /** Request kind the primary Hand to sends: automatic uses the recorded target, so no picker. */
  handOffSource: StageDispatchSource | null;
  handOff: () => Promise<void>;
  retry: () => Promise<void>;
  cancel: () => Promise<void>;
  clearStale: () => void;
}

/** Maps controller state to the props StageHandoffControl renders. */
export function stageDispatchActions(
  controller: StageDispatchController,
  state: StageDispatchState,
  descriptor: StageHandoffDescriptor | undefined,
): StageDispatchActions {
  return {
    selectedAgentId: state.selectedAgentId,
    setSelectedAgentId: (id) => controller.setSelectedAgentId(id),
    clientState: state.clientState,
    activeRequestId: state.activeRequestId,
    receipt: state.receipt,
    staleMessage: state.staleMessage,
    errorMessage: state.errorMessage,
    busy: state.busy,
    disabledReason: stageDispatchDisabledReason(state, descriptor),
    handOffSource: primaryHandOffSource(state, descriptor),
    handOff: () => controller.handOff(),
    retry: () => controller.retry(),
    cancel: () => controller.cancel(),
    clearStale: () => controller.clearMessages(),
  };
}

/**
 * Thin React binding for StageDispatchController (one controller per ticket).
 * All dispatch orchestration lives in the controller.
 */
export function useStageDispatch(args: {
  ticketId: string;
  descriptor: StageHandoffDescriptor | undefined;
  onTicketRefetch: () => void;
}): StageDispatchActions {
  const { ticketId, descriptor, onTicketRefetch } = args;
  const refetchRef = useRef(onTicketRefetch);
  refetchRef.current = onTicketRefetch;

  const controller = useMemo(
    () => new StageDispatchController({ ticketId, onTicketRefetch: () => refetchRef.current() }),
    [ticketId],
  );

  useEffect(() => {
    controller.start();
    return () => controller.stop();
  }, [controller]);

  useEffect(() => {
    controller.sync(descriptor);
  }, [controller, descriptor]);

  useWebSocket((msg) => {
    if (msg.type !== 'stage-dispatch') return;
    controller.handleFrame(msg.payload as { ticketId?: string; requestId?: string } | undefined);
  });

  const state = useSyncExternalStore(controller.subscribe, controller.getState);
  return useMemo(
    () => stageDispatchActions(controller, state, descriptor),
    [controller, state, descriptor],
  );
}
