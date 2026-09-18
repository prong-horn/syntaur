import { describe, expect, it } from 'vitest';
import type { StageHandoffDescriptor } from '../../hooks/useProjects';
import {
  applyDescriptorSync,
  applyDispatchAccepted,
  applyDispatchUnknown,
  applyReceiptLookup,
  applyStaleEntryMessage,
  automaticRequestId,
  beginStageDispatchAction,
  endStageDispatchAction,
  initialStageDispatchState,
  isPollingClientState,
  resetStageDispatchForTicket,
  resolveHandOffRequest,
  resolveRetryRequest,
  runGuardedStageDispatchAction,
  shouldIgnoreAsyncResult,
  shouldUseAutomaticHandOff,
  stageDispatchDisabledReason,
} from '../stage-dispatch-controller';
import { resolveStartAgentOverride } from '../../components/StartAgentPicker';

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

describe('stage-dispatch-controller', () => {
  it('blocks duplicate actions while one is in flight', () => {
    let state = initialStageDispatchState('T-1');
    const begun = beginStageDispatchAction(state);
    expect(begun.ok).toBe(true);
    state = begun.state;
    expect(beginStageDispatchAction(state).ok).toBe(false);
    state = endStageDispatchAction(state);
    expect(beginStageDispatchAction(state).ok).toBe(true);
  });

  it('resets ticket-local state on navigation', () => {
    let state = initialStageDispatchState('T-1');
    state = applyDispatchAccepted(state, 'req-1', {
      requestId: 'req-1',
      entryId: 'entry-1',
      agentId: 'cursor',
      stage: 'in_progress',
      state: 'running',
    });
    state = resetStageDispatchForTicket(state, 'T-2');
    expect(state.ticketId).toBe('T-2');
    expect(state.activeRequestId).toBeNull();
    expect(state.clientState).toBe('idle');
    expect(state.generation).toBe(1);
  });

  it('ignores async results from an older generation', () => {
    const state = resetStageDispatchForTicket(initialStageDispatchState('T-1'), 'T-1');
    expect(shouldIgnoreAsyncResult(state, 'T-1', 0)).toBe(true);
    expect(shouldIgnoreAsyncResult(state, 'T-2', state.generation)).toBe(true);
    expect(shouldIgnoreAsyncResult(state, 'T-1', state.generation)).toBe(false);
  });

  it('restores non-terminal receipt from descriptor on refresh', () => {
    const synced = applyDescriptorSync(initialStageDispatchState('T-1'), {
      ...descriptor,
      latestReceipt: {
        requestId: 'auto~entry-1',
        entryId: 'entry-1',
        agentId: 'cursor',
        stage: 'in_progress',
        state: 'queued',
      },
    });
    expect(synced.activeRequestId).toBe('auto~entry-1');
    expect(synced.clientState).toBe('queued');
  });

  it('keeps unknown acceptance when the descriptor has no receipt for that id', () => {
    let state = applyDispatchUnknown(initialStageDispatchState('T-1'), 'manual-1');
    state = applyDescriptorSync(state, descriptor);
    expect(state.clientState).toBe('unknown');
    state = applyDescriptorSync(state, {
      ...descriptor,
      latestReceipt: {
        requestId: 'other-1',
        entryId: 'entry-1',
        agentId: 'cursor',
        stage: 'in_progress',
        state: 'running',
      },
    });
    expect(state.clientState).toBe('unknown');
    expect(state.activeRequestId).toBe('manual-1');
  });

  it('resolves unknown acceptance from a server receipt for the same id', () => {
    let state = applyDispatchUnknown(initialStageDispatchState('T-1'), 'auto~entry-1');
    state = applyDescriptorSync(state, {
      ...descriptor,
      latestReceipt: {
        requestId: 'auto~entry-1',
        entryId: 'entry-1',
        agentId: 'cursor',
        stage: 'in_progress',
        state: 'queued',
      },
    });
    expect(state.clientState).toBe('queued');
    expect(state.activeRequestId).toBe('auto~entry-1');
  });

  it('resets request, receipt, and selection on a new stage entry', () => {
    let state = applyDescriptorSync(initialStageDispatchState('T-1'), descriptor);
    state = applyDispatchAccepted({ ...state, selectedAgentId: 'reviewer' }, 'manual-1', {
      requestId: 'manual-1',
      entryId: 'entry-1',
      agentId: 'reviewer',
      stage: 'in_progress',
      state: 'completed',
    });
    state = { ...state, selectedAgentId: 'reviewer', staleMessage: 'old' };
    const next = applyDescriptorSync(state, { ...descriptor, entryId: 'entry-2', auto: true });
    expect(next).toMatchObject({
      descriptorEntryId: 'entry-2',
      activeRequestId: null,
      receipt: null,
      clientState: 'idle',
      selectedAgentId: null,
      staleMessage: null,
      generation: state.generation + 1,
    });
    expect(resolveHandOffRequest(next, { ...descriptor, entryId: 'entry-2', auto: true }, () => 'x'))
      .toEqual({ requestId: 'auto~entry-2', source: 'automatic' });
  });

  it('adopts the new entry receipt after resetting', () => {
    const state = applyDispatchUnknown(
      applyDescriptorSync(initialStageDispatchState('T-1'), descriptor),
      'auto~entry-1',
    );
    const next = applyDescriptorSync(state, {
      ...descriptor,
      entryId: 'entry-2',
      latestReceipt: {
        requestId: 'auto~entry-2',
        entryId: 'entry-2',
        agentId: 'cursor',
        stage: 'review',
        state: 'running',
      },
    });
    expect(next.clientState).toBe('running');
    expect(next.activeRequestId).toBe('auto~entry-2');
  });

  it('lets a different active server receipt take over a terminal local one', () => {
    const local = applyDispatchAccepted(
      applyDescriptorSync(initialStageDispatchState('T-1'), descriptor),
      'manual-1',
      {
        requestId: 'manual-1',
        entryId: 'entry-1',
        agentId: 'cursor',
        stage: 'in_progress',
        state: 'completed',
      },
    );
    const next = applyDescriptorSync(local, {
      ...descriptor,
      canDispatch: false,
      latestReceipt: {
        requestId: 'other-1',
        entryId: 'entry-1',
        agentId: 'cursor',
        stage: 'in_progress',
        state: 'queued',
      },
    });
    expect(next.activeRequestId).toBe('other-1');
    expect(next.clientState).toBe('queued');
    expect(isPollingClientState(next.clientState)).toBe(true);
  });

  it('does not regress a local receipt from an older server snapshot', () => {
    const local = applyDispatchAccepted(
      applyDescriptorSync(initialStageDispatchState('T-1'), descriptor),
      'manual-1',
      {
        requestId: 'manual-1',
        entryId: 'entry-1',
        agentId: 'cursor',
        stage: 'in_progress',
        state: 'completed',
      },
    );
    const stale = {
      requestId: 'manual-1',
      entryId: 'entry-1',
      agentId: 'cursor',
      stage: 'in_progress',
      state: 'running' as const,
    };
    expect(applyDescriptorSync(local, { ...descriptor, latestReceipt: stale }).clientState).toBe(
      'completed',
    );
    expect(applyReceiptLookup(local, 'manual-1', stale).clientState).toBe('completed');
  });

  it('keeps auto id in unknown state when receipt lookup returns 404', () => {
    const state = applyDispatchUnknown(
      { ...initialStageDispatchState('T-1'), activeRequestId: 'auto~entry-1' },
      'auto~entry-1',
    );
    const next = applyReceiptLookup(state, 'auto~entry-1', null);
    expect(next.clientState).toBe('unknown');
    expect(next.activeRequestId).toBe('auto~entry-1');
  });

  it('reuses the same request id for unknown retry', () => {
    const state = applyDispatchUnknown(initialStageDispatchState('T-1'), 'auto~entry-1');
    const retry = resolveRetryRequest(state, descriptor, () => 'new-id');
    expect(retry).toEqual({ requestId: 'auto~entry-1', source: 'automatic' });
  });

  it('mints a fresh manual id only after completed turn', () => {
    let state = applyDispatchAccepted(initialStageDispatchState('T-1'), 'manual-1', {
      requestId: 'manual-1',
      entryId: 'entry-1',
      agentId: 'cursor',
      stage: 'in_progress',
      state: 'completed',
    });
    const retry = resolveRetryRequest(state, descriptor, () => 'manual-2');
    expect(retry.requestId).toBe('manual-2');
    expect(retry.source).toBe('manual');
  });

  it('retries automatic dispatch with stable auto id when missed', () => {
    const retry = resolveRetryRequest(initialStageDispatchState('T-1'), {
      ...descriptor,
      auto: true,
    }, () => 'ignored');
    expect(retry).toEqual({
      requestId: automaticRequestId('entry-1'),
      source: 'automatic',
    });
  });

  it('polls only for queued, running, and unknown states', () => {
    expect(isPollingClientState('queued')).toBe(true);
    expect(isPollingClientState('running')).toBe(true);
    expect(isPollingClientState('unknown')).toBe(true);
    expect(isPollingClientState('completed')).toBe(false);
    expect(isPollingClientState('idle')).toBe(false);
  });

  it('surfaces stale entry conflicts inline', () => {
    const state = applyStaleEntryMessage(initialStageDispatchState('T-1'), 'Stale stage entry');
    expect(state.staleMessage).toContain('Stale');
  });

  it('explains disabled handoff while resolving unknown acceptance', () => {
    const state = applyDispatchUnknown(initialStageDispatchState('T-1'), 'auto~entry-1');
    expect(stageDispatchDisabledReason(state, descriptor)).toContain('Resolving');
  });

  it('clears one-use manual selection after accepted dispatch', () => {
    const state = applyDispatchAccepted(
      { ...initialStageDispatchState('T-1'), selectedAgentId: 'reviewer' },
      'manual-1',
      {
        requestId: 'manual-1',
        entryId: 'entry-1',
        agentId: 'reviewer',
        stage: 'in_progress',
        state: 'queued',
      },
    );
    expect(state.selectedAgentId).toBeNull();
  });

  it('mints unique manual handoff ids on manual stages', () => {
    const state = initialStageDispatchState('T-1');
    const first = resolveHandOffRequest(state, descriptor, () => 'uuid-1');
    const second = resolveHandOffRequest(state, descriptor, () => 'uuid-2');
    expect(first).toEqual({ requestId: 'uuid-1', source: 'manual' });
    expect(second).toEqual({ requestId: 'uuid-2', source: 'manual' });
  });

  it('uses stable auto id for primary handoff on missed automatic stages', () => {
    const state = initialStageDispatchState('T-1');
    const handoff = resolveHandOffRequest(state, { ...descriptor, auto: true }, () => 'ignored');
    expect(handoff).toEqual({
      requestId: automaticRequestId('entry-1'),
      source: 'automatic',
    });
    expect(shouldUseAutomaticHandOff(state, { ...descriptor, auto: true })).toBe(true);
  });

  it('mints a fresh manual id after terminal failed receipt on retry', () => {
    const state = applyDispatchAccepted(initialStageDispatchState('T-1'), 'auto~entry-1', {
      requestId: 'auto~entry-1',
      entryId: 'entry-1',
      agentId: 'cursor',
      stage: 'in_progress',
      state: 'failed',
      error: 'target disabled',
    });
    const retry = resolveRetryRequest(state, { ...descriptor, auto: true }, () => 'manual-retry');
    expect(retry).toEqual({ requestId: 'manual-retry', source: 'manual' });
  });

  it('blocks duplicate guarded actions before React re-render', async () => {
    const ref = { current: initialStageDispatchState('T-1') };
    const runs: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = runGuardedStageDispatchAction(
      ref,
      async () => {
        runs.push('first-start');
        await firstGate;
        runs.push('first-end');
      },
      (next) => {
        ref.current = next;
      },
    );
    const second = runGuardedStageDispatchAction(
      ref,
      async () => {
        runs.push('second');
      },
      (next) => {
        ref.current = next;
      },
    );

    await Promise.resolve();
    expect(runs).toEqual(['first-start']);
    releaseFirst?.();
    await Promise.all([first, second]);
    expect(runs).toEqual(['first-start', 'first-end']);
  });
});

describe('resolveStartAgentOverride', () => {
  it('uses explicit override when set', () => {
    expect(resolveStartAgentOverride('reviewer', 'cursor')).toBe('reviewer');
  });

  it('sends no override when the picker is untouched (template policy applies)', () => {
    expect(resolveStartAgentOverride(null, 'cursor')).toBeUndefined();
  });

  it('never sends the template default as an explicit override', () => {
    expect(resolveStartAgentOverride('cursor', 'cursor')).toBeUndefined();
  });

  it('returns undefined when no agent is chosen', () => {
    expect(resolveStartAgentOverride(null, null)).toBeUndefined();
  });
});
