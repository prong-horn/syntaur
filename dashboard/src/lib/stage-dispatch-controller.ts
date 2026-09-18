import type {
  StageHandoffDescriptor,
  StageHandoffReceiptSummary,
} from '../data/types';
import { requestResponse, type FetchLike } from '../data/client';
import {
  STAGE_DISPATCH_POST_TIMEOUT_MS,
  parseStageHandoffReceipt,
  readStageDispatchReceipt,
  submitStageDispatchPost,
} from './stage-dispatch-runtime';

export type StageDispatchClientState =
  | 'idle'
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted'
  | 'superseded'
  | 'unknown';

const TERMINAL = new Set<StageHandoffReceiptSummary['state']>([
  'completed',
  'failed',
  'cancelled',
  'interrupted',
  'superseded',
]);

export function isPollingClientState(state: StageDispatchClientState): boolean {
  return state === 'queued' || state === 'running' || state === 'unknown';
}

export interface StageDispatchState {
  ticketId: string;
  generation: number;
  selectedAgentId: string | null;
  clientState: StageDispatchClientState;
  activeRequestId: string | null;
  receipt: StageHandoffReceiptSummary | null;
  staleMessage: string | null;
  /** Last non-stale action failure (HTTP error, missing agent, refused handoff). */
  errorMessage: string | null;
  busy: boolean;
  /** Synchronous in-flight guard — blocks duplicate handOff/retry/cancel clicks. */
  actionInFlight: boolean;
  descriptorEntryId: string | null;
}

export function initialStageDispatchState(ticketId: string): StageDispatchState {
  return {
    ticketId,
    generation: 0,
    selectedAgentId: null,
    clientState: 'idle',
    activeRequestId: null,
    receipt: null,
    staleMessage: null,
    errorMessage: null,
    busy: false,
    actionInFlight: false,
    descriptorEntryId: null,
  };
}

export function resetStageDispatchForTicket(
  state: StageDispatchState,
  ticketId: string,
): StageDispatchState {
  if (state.ticketId === ticketId && state.generation === 0 && state.clientState === 'idle') {
    return { ...initialStageDispatchState(ticketId), generation: state.generation + 1 };
  }
  return {
    ...initialStageDispatchState(ticketId),
    generation: state.generation + 1,
  };
}

function receiptRank(state: StageHandoffReceiptSummary['state'] | undefined): number {
  if (!state) return -1;
  if (state === 'queued') return 0;
  if (state === 'running') return 1;
  return 2;
}

/**
 * Reconcile local state with the server descriptor (ticket refetch, navigation,
 * browser refresh).
 *
 * - A new stage entry resets request/receipt/selection and bumps `generation`
 *   so async results for the previous entry are ignored. The in-flight guard
 *   survives; the old action's `finally` releases it.
 * - Same request id: the further-along state wins; a server receipt resolves
 *   `unknown` acceptance definitively.
 * - A different, still-active server receipt takes over a terminal local one
 *   (another tab, CLI, or automatic entry dispatch) so the UI polls it and
 *   never offers a duplicate handoff.
 * - `unknown` for a different request is kept until our own id resolves.
 */
export function applyDescriptorSync(
  state: StageDispatchState,
  descriptor: StageHandoffDescriptor | undefined,
): StageDispatchState {
  if (!descriptor) return state;

  let base = state;
  if (state.descriptorEntryId !== null && state.descriptorEntryId !== descriptor.entryId) {
    base = {
      ...initialStageDispatchState(state.ticketId),
      generation: state.generation + 1,
      busy: state.busy,
      actionInFlight: state.actionInFlight,
    };
  }
  if (base.descriptorEntryId !== descriptor.entryId) {
    base = { ...base, descriptorEntryId: descriptor.entryId };
  }

  const latest =
    descriptor.latestReceipt && descriptor.latestReceipt.entryId === descriptor.entryId
      ? descriptor.latestReceipt
      : undefined;
  if (!latest) return base;

  const active = base.activeRequestId;
  if (!active) {
    if (base.clientState === 'unknown') return base;
    if (base.receipt?.requestId === latest.requestId && base.receipt.state === latest.state) {
      return base;
    }
    return {
      ...base,
      activeRequestId: TERMINAL.has(latest.state) ? null : latest.requestId,
      receipt: latest,
      clientState: latest.state,
    };
  }

  if (latest.requestId === active) {
    if (base.clientState === 'unknown' || receiptRank(latest.state) > receiptRank(base.receipt?.state)) {
      return { ...base, receipt: latest, clientState: latest.state };
    }
    return base;
  }

  if (base.clientState === 'unknown') return base;
  const localTerminal = base.receipt ? TERMINAL.has(base.receipt.state) : false;
  if (localTerminal && !TERMINAL.has(latest.state)) {
    return {
      ...base,
      activeRequestId: latest.requestId,
      receipt: latest,
      clientState: latest.state,
    };
  }
  return base;
}

export function beginStageDispatchAction(state: StageDispatchState): {
  ok: boolean;
  state: StageDispatchState;
} {
  if (state.actionInFlight || state.busy) {
    return { ok: false, state };
  }
  return {
    ok: true,
    state: {
      ...state,
      actionInFlight: true,
      busy: true,
      staleMessage: null,
      errorMessage: null,
    },
  };
}

export function endStageDispatchAction(state: StageDispatchState): StageDispatchState {
  return {
    ...state,
    actionInFlight: false,
    busy: false,
  };
}

export function mintManualRequestId(mintUuid: () => string): string {
  return mintUuid();
}

export function automaticRequestId(entryId: string): string {
  return `auto~${entryId}`;
}

/** Primary handoff on auto entries (recorded auto or start override) with no terminal receipt uses stable auto~entryId. */
export function shouldUseAutomaticHandOff(
  state: StageDispatchState,
  descriptor: StageHandoffDescriptor,
): boolean {
  if (!descriptor.auto || descriptor.manualFallback) return false;
  if (state.clientState === 'unknown') return false;
  const receipt = state.receipt;
  if (receipt && TERMINAL.has(receipt.state)) return false;
  return true;
}

export function resolveHandOffRequest(
  state: StageDispatchState,
  descriptor: StageHandoffDescriptor,
  mintUuid: () => string,
): { requestId: string; source: 'manual' | 'automatic' } {
  if (shouldUseAutomaticHandOff(state, descriptor)) {
    return {
      requestId: automaticRequestId(descriptor.entryId),
      source: 'automatic',
    };
  }
  return { requestId: mintManualRequestId(mintUuid), source: 'manual' };
}

export function resolveRetryRequest(
  state: StageDispatchState,
  descriptor: StageHandoffDescriptor,
  mintUuid: () => string,
): { requestId: string; source: 'manual' | 'automatic' } {
  const existing = state.activeRequestId;

  if (existing && state.clientState === 'unknown') {
    return {
      requestId: existing,
      source: existing.startsWith('auto~') ? 'automatic' : 'manual',
    };
  }

  if (state.receipt?.state === 'completed') {
    return resolveHandOffRequest(state, descriptor, mintUuid);
  }

  if (
    state.receipt &&
    (state.receipt.state === 'failed' ||
      state.receipt.state === 'cancelled' ||
      state.receipt.state === 'interrupted' ||
      state.receipt.state === 'superseded')
  ) {
    return { requestId: mintManualRequestId(mintUuid), source: 'manual' };
  }

  if (descriptor.auto && !descriptor.manualFallback) {
    return {
      requestId: automaticRequestId(descriptor.entryId),
      source: 'automatic',
    };
  }

  return resolveHandOffRequest(state, descriptor, mintUuid);
}

export function applyDispatchAccepted(
  state: StageDispatchState,
  requestId: string,
  receipt: StageHandoffReceiptSummary,
): StageDispatchState {
  return {
    ...state,
    activeRequestId: requestId,
    receipt,
    clientState: receipt.state,
    selectedAgentId: null,
  };
}

export function applyDispatchUnknown(
  state: StageDispatchState,
  requestId: string,
): StageDispatchState {
  return {
    ...state,
    activeRequestId: requestId,
    clientState: 'unknown',
  };
}

export function applyReceiptLookup(
  state: StageDispatchState,
  requestId: string,
  receipt: StageHandoffReceiptSummary | null,
): StageDispatchState {
  if (state.activeRequestId !== requestId) return state;

  if (!receipt) {
    return { ...state, clientState: 'unknown' };
  }

  // A slow poll must not regress a receipt that already advanced.
  if (
    state.clientState !== 'unknown' &&
    receiptRank(receipt.state) < receiptRank(state.receipt?.state)
  ) {
    return state;
  }

  return {
    ...state,
    receipt,
    clientState: receipt.state,
  };
}

export function applyStaleEntryMessage(
  state: StageDispatchState,
  message: string,
): StageDispatchState {
  return { ...state, staleMessage: message };
}

export function stageDispatchDisabledReason(
  state: StageDispatchState,
  descriptor: StageHandoffDescriptor | undefined,
): string | null {
  if (descriptor?.reason) return descriptor.reason;
  if (state.clientState === 'unknown') {
    return 'Resolving prior handoff acceptance…';
  }
  if (isPollingClientState(state.clientState)) {
    return `Handoff ${state.clientState}`;
  }
  return null;
}

export function shouldIgnoreAsyncResult(
  state: StageDispatchState,
  ticketId: string,
  generation: number,
): boolean {
  return state.ticketId !== ticketId || state.generation !== generation;
}

export interface StageDispatchStateRef {
  current: StageDispatchState;
}

/** Synchronous in-flight guard — updates ref before React render so same-tick clicks share one id. */
export async function runGuardedStageDispatchAction(
  ref: StageDispatchStateRef,
  run: () => Promise<void>,
  onStateChange: (state: StageDispatchState) => void,
): Promise<void> {
  const begun = beginStageDispatchAction(ref.current);
  if (!begun.ok) return;
  ref.current = begun.state;
  onStateChange(ref.current);
  try {
    await run();
  } finally {
    ref.current = endStageDispatchAction(ref.current);
    onStateChange(ref.current);
  }
}

export type StageDispatchSource = 'manual' | 'automatic';

/** Which request kind the primary Hand to action would send right now. */
export function primaryHandOffSource(
  state: StageDispatchState,
  descriptor: StageHandoffDescriptor | undefined,
): StageDispatchSource | null {
  if (!descriptor) return null;
  return shouldUseAutomaticHandOff(state, descriptor) ? 'automatic' : 'manual';
}

export interface StageDispatchControllerOptions {
  ticketId: string;
  onTicketRefetch: () => void;
  mintUuid?: () => string;
  /** Injected transport; defaults to the client's raw `requestResponse`. */
  fetchImpl?: FetchLike;
  pollMs?: number;
  postTimeoutMs?: number;
}

export const STAGE_DISPATCH_POLL_MS = 2000;

function errorText(payload: unknown, status: number): string {
  return (payload as { error?: string } | null)?.error || `HTTP ${status}`;
}

/**
 * Authoritative per-ticket stage dispatch orchestration: descriptor
 * reconciliation, guarded handOff/retry/cancel, POST timeout → unknown →
 * same-id polling, and websocket refresh. `useStageDispatch` only binds it
 * to React; tests drive this class directly.
 *
 * Lifecycle: `start()` arms polling with a fresh abort signal; `stop()` aborts
 * polls/cancel reads and ignores every later async result (unmount or ticket
 * navigation). start/stop may repeat (React StrictMode).
 */
export class StageDispatchController {
  readonly ticketId: string;
  private state: StageDispatchState;
  private descriptor: StageHandoffDescriptor | undefined;
  private readonly listeners = new Set<() => void>();
  private readonly onTicketRefetch: () => void;
  private readonly mintUuid: () => string;
  private readonly fetchImpl: FetchLike;
  private readonly pollMs: number;
  private readonly postTimeoutMs: number;
  private lifecycle: AbortController | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private pollInFlight = false;
  private active = false;

  constructor(options: StageDispatchControllerOptions) {
    this.ticketId = options.ticketId;
    this.state = initialStageDispatchState(options.ticketId);
    this.onTicketRefetch = options.onTicketRefetch;
    this.mintUuid = options.mintUuid ?? (() => crypto.randomUUID());
    this.fetchImpl = options.fetchImpl ?? requestResponse;
    this.pollMs = options.pollMs ?? STAGE_DISPATCH_POLL_MS;
    this.postTimeoutMs = options.postTimeoutMs ?? STAGE_DISPATCH_POST_TIMEOUT_MS;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getState = (): StageDispatchState => this.state;

  getDescriptor(): StageHandoffDescriptor | undefined {
    return this.descriptor;
  }

  primarySource(): StageDispatchSource | null {
    return primaryHandOffSource(this.state, this.descriptor);
  }

  disabledReason(): string | null {
    return stageDispatchDisabledReason(this.state, this.descriptor);
  }

  start(): void {
    if (this.active) return;
    this.active = true;
    this.lifecycle = new AbortController();
    this.updatePolling();
  }

  stop(): void {
    this.active = false;
    this.lifecycle?.abort();
    this.lifecycle = null;
    this.clearPollTimer();
  }

  sync(descriptor: StageHandoffDescriptor | undefined): void {
    this.descriptor = descriptor;
    this.commit(applyDescriptorSync(this.state, descriptor));
  }

  setSelectedAgentId(id: string | null): void {
    this.commit({ ...this.state, selectedAgentId: id });
  }

  clearMessages(): void {
    this.commit({ ...this.state, staleMessage: null, errorMessage: null });
  }

  handOff(): Promise<void> {
    return this.runGuarded(async () => {
      const descriptor = this.descriptor;
      if (!descriptor) return;
      if (isPollingClientState(this.state.clientState)) return;
      if (!descriptor.canDispatch) {
        this.fail(descriptor.reason ?? 'Handoff is not available for this stage entry');
        return;
      }
      if (!this.hasManualTarget(descriptor)) return;
      const { requestId, source } = resolveHandOffRequest(this.state, descriptor, this.mintUuid);
      await this.post(descriptor, requestId, source);
    });
  }

  retry(): Promise<void> {
    return this.runGuarded(async () => {
      const descriptor = this.descriptor;
      if (!descriptor) return;
      const sameIdRetry = this.state.clientState === 'unknown' && this.state.activeRequestId;
      if (!sameIdRetry) {
        if (isPollingClientState(this.state.clientState)) return;
        if (!descriptor.canDispatch) {
          this.fail(descriptor.reason ?? 'Handoff is not available for this stage entry');
          return;
        }
        if (!this.hasManualTarget(descriptor)) return;
      }
      const { requestId, source } = resolveRetryRequest(this.state, descriptor, this.mintUuid);
      await this.post(descriptor, requestId, source);
    });
  }

  cancel(): Promise<void> {
    const requestId = this.state.activeRequestId;
    if (!requestId) return Promise.resolve();
    return this.runGuarded(async () => {
      const generation = this.state.generation;
      const signal = this.lifecycle?.signal;
      const response = await this.fetchImpl(
        `/api/tickets/${encodeURIComponent(this.ticketId)}/dispatch/${encodeURIComponent(requestId)}/cancel`,
        { method: 'POST', signal },
      );
      const payload = await response.json().catch(() => null);
      if (this.isStale(generation)) return;
      if (!response.ok) {
        this.fail(errorText(payload, response.status));
        return;
      }
      const receipt = await readStageDispatchReceipt(this.ticketId, requestId, signal, this.fetchImpl);
      if (this.isStale(generation)) return;
      this.commit(applyReceiptLookup(this.state, requestId, receipt));
      this.onTicketRefetch();
    });
  }

  /** Handle a `stage-dispatch` websocket payload. */
  handleFrame(payload: { ticketId?: string; requestId?: string } | undefined): void {
    if (payload?.ticketId !== this.ticketId) return;
    // Any dispatch on this ticket may change the descriptor (new entry, other tab, CLI).
    this.onTicketRefetch();
    const active = this.state.activeRequestId;
    if (active && (!payload.requestId || payload.requestId === active)) {
      void this.poll();
    }
  }

  async poll(): Promise<void> {
    const requestId = this.state.activeRequestId;
    if (!requestId || this.pollInFlight || !this.active) return;
    const generation = this.state.generation;
    const signal = this.lifecycle?.signal;
    this.pollInFlight = true;
    try {
      const receipt = await readStageDispatchReceipt(this.ticketId, requestId, signal, this.fetchImpl);
      if (this.isStale(generation)) return;
      this.commit(applyReceiptLookup(this.state, requestId, receipt));
      if (receipt && TERMINAL.has(receipt.state)) this.onTicketRefetch();
    } catch {
      // Abort or transient error: the next interval tick retries.
    } finally {
      this.pollInFlight = false;
    }
  }

  private async post(
    descriptor: StageHandoffDescriptor,
    requestId: string,
    source: StageDispatchSource,
  ): Promise<void> {
    const generation = this.state.generation;
    const agentId =
      source === 'automatic'
        ? undefined
        : this.state.selectedAgentId ?? descriptor.defaultAgentId ?? undefined;

    let result: Awaited<ReturnType<typeof submitStageDispatchPost>>;
    try {
      result = await submitStageDispatchPost({
        ticketId: this.ticketId,
        entryId: descriptor.entryId,
        requestId,
        source,
        agentId,
        fetchImpl: this.fetchImpl,
        timeoutMs: this.postTimeoutMs,
      });
    } catch {
      // Network failure: acceptance is uncertain, so recover with the same id.
      if (this.isStale(generation)) return;
      this.commit(applyDispatchUnknown(this.state, requestId));
      return;
    }
    if (this.isStale(generation)) return;

    if (result.timedOut) {
      this.commit(applyDispatchUnknown(this.state, requestId));
      return;
    }

    const { response, payload } = result;
    if (response.status === 409) {
      this.commit(applyStaleEntryMessage(this.state, errorText(payload, 409)));
      this.onTicketRefetch();
      return;
    }
    if (response.status >= 500 && response.status !== 503) {
      // Server may have accepted before failing; resolve by the same id.
      this.commit(applyDispatchUnknown(this.state, requestId));
      return;
    }
    if (!response.ok) {
      this.fail(errorText(payload, response.status));
      return;
    }
    const receipt = parseStageHandoffReceipt(payload);
    if (!receipt || receipt.requestId !== requestId) {
      // 2xx but unreadable body: accepted-or-not is unknown; poll the stable id.
      this.commit(applyDispatchUnknown(this.state, requestId));
      this.onTicketRefetch();
      return;
    }
    this.commit(applyDispatchAccepted(this.state, requestId, receipt));
    this.onTicketRefetch();
  }

  /** Synchronous in-flight guard: same-tick clicks see `actionInFlight` before any render. */
  private async runGuarded(run: () => Promise<void>): Promise<void> {
    const begun = beginStageDispatchAction(this.state);
    if (!begun.ok) return;
    this.commit(begun.state);
    const generation = this.state.generation;
    try {
      await run();
    } catch (err) {
      if (!this.isStale(generation) && !(err instanceof Error && err.name === 'AbortError')) {
        this.fail(err instanceof Error ? err.message : String(err));
      }
    } finally {
      this.commit(endStageDispatchAction(this.state));
    }
  }

  /** A manual request needs a chosen or template agent; checked before minting an id. */
  private hasManualTarget(descriptor: StageHandoffDescriptor): boolean {
    if (primaryHandOffSource(this.state, descriptor) !== 'manual') return true;
    if (this.state.selectedAgentId ?? descriptor.defaultAgentId) return true;
    this.fail('Select an agent to hand off work');
    return false;
  }

  private fail(message: string): void {
    this.commit({ ...this.state, errorMessage: message });
  }

  private isStale(generation: number): boolean {
    return !this.active || this.state.generation !== generation;
  }

  private commit(next: StageDispatchState): void {
    if (next === this.state) return;
    this.state = next;
    this.updatePolling();
    for (const listener of this.listeners) listener();
  }

  private updatePolling(): void {
    const shouldPoll =
      this.active &&
      Boolean(this.state.activeRequestId) &&
      isPollingClientState(this.state.clientState);
    if (shouldPoll && !this.pollTimer) {
      this.pollTimer = setInterval(() => {
        void this.poll();
      }, this.pollMs);
    } else if (!shouldPoll) {
      this.clearPollTimer();
    }
  }

  private clearPollTimer(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }
}
