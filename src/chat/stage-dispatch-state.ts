import type { ChatEvent } from './types.js';

export type StageDispatchReceiptState =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted'
  | 'superseded';

const TERMINAL_RECEIPT_STATES: StageDispatchReceiptState[] = [
  'completed',
  'failed',
  'cancelled',
  'interrupted',
  'superseded',
];

export function isTerminalStageReceiptState(state: StageDispatchReceiptState): boolean {
  return TERMINAL_RECEIPT_STATES.includes(state);
}

export interface StageDispatchReceipt {
  requestId: string;
  entryId: string;
  agentId: string;
  stage: string;
  role: string;
  source: 'automatic' | 'manual';
  state: StageDispatchReceiptState;
  turnId?: string;
  error?: string;
}

export interface StageDispatchAcceptance {
  requestId: string;
  entryId: string;
  agentId: string;
  stage: string;
  role: string;
  source: 'automatic' | 'manual';
  policyDigest: string;
}

function parseDispatchEvent(event: ChatEvent): StageDispatchAcceptance | null {
  if (event.kind !== 'stage.dispatch') return null;
  const p = event.payload as {
    requestId?: string;
    entryId?: string;
    agentId?: string;
    stage?: string;
    role?: string;
    source?: string;
    policyDigest?: string;
    state?: string;
  };
  if (
    !p.requestId ||
    !p.entryId ||
    !p.agentId ||
    !p.stage ||
    !p.role ||
    !p.source ||
    !p.policyDigest
  ) {
    return null;
  }
  return {
    requestId: p.requestId,
    entryId: p.entryId,
    agentId: p.agentId,
    stage: p.stage,
    role: p.role,
    source: p.source as 'automatic' | 'manual',
    policyDigest: p.policyDigest,
  };
}

/**
 * Pure receipt reader from chat events — never starts work.
 */
export function readStageDispatchReceipt(
  events: ChatEvent[],
  requestId: string,
): StageDispatchReceipt | null {
  let acceptance: StageDispatchAcceptance | null = null;
  let state: StageDispatchReceiptState = 'queued';
  let turnId: string | undefined;
  let error: string | undefined;
  let terminal = false;

  for (const event of events) {
    if (event.kind === 'stage.dispatch') {
      const p = event.payload as { requestId?: string; state?: string };
      if (p.requestId !== requestId) continue;
      acceptance = parseDispatchEvent(event);
      if (p.state === 'queued') state = 'queued';
    }
    if (event.kind === 'stage.dispatch.state') {
      const p = event.payload as {
        requestId?: string;
        state?: StageDispatchReceiptState;
        turnId?: string;
        error?: string;
      };
      if (p.requestId !== requestId) continue;
      if (p.state) {
        if (terminal && state === 'completed' && p.state === 'cancelled') {
          continue;
        }
        state = p.state;
        terminal = isTerminalStageReceiptState(p.state);
      }
      if (p.turnId) turnId = p.turnId;
      if (p.error) error = p.error;
    }
    if (event.kind === 'turn.start' && event.turnId && !terminal) {
      const trigger = (event.payload as { trigger?: { kind?: string; requestId?: string } })
        .trigger;
      if (trigger?.kind === 'stage' && trigger.requestId === requestId) {
        state = 'running';
        turnId = event.turnId;
      }
    }
    if (event.kind === 'turn.end' || event.kind === 'turn.cancel') {
      if (!turnId || event.turnId !== turnId) continue;
      if (terminal) continue;
      const p = event.payload as { stopReason?: string; error?: string };
      if (state === 'cancelled' && p.stopReason !== 'cancelled') {
        continue;
      }
      if (p.stopReason === 'cancelled') state = 'cancelled';
      else if (p.stopReason === 'interrupted') state = 'interrupted';
      else if (p.stopReason === 'error') {
        state = 'failed';
        error = p.error;
      } else state = 'completed';
      terminal = true;
    }
  }

  if (!acceptance) return null;
  return {
    requestId: acceptance.requestId,
    entryId: acceptance.entryId,
    agentId: acceptance.agentId,
    stage: acceptance.stage,
    role: acceptance.role,
    source: acceptance.source,
    state,
    turnId,
    error,
  };
}

export function listStageDispatchRequestIds(events: ChatEvent[]): string[] {
  const ids = new Set<string>();
  for (const event of events) {
    if (event.kind === 'stage.dispatch') {
      const p = event.payload as { requestId?: string };
      if (p.requestId) ids.add(p.requestId);
    }
  }
  return [...ids];
}
