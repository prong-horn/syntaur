import type { ChatEvent } from '../chat/types.js';
import type { AgentDefinition } from '../chat/types.js';
import { latestStageEntryForTicket, type StageEntryEvent } from '../db/events-db.js';
import {
  listStageDispatchRequestIds,
  readStageDispatchReceipt,
  type StageDispatchReceipt,
} from '../chat/stage-dispatch-state.js';
import {
  buildManualFallbackEntryId,
  stageEntryMatchesStatus,
} from '../lifecycle/stage-entry.js';
import type { StageId, TemplateManifest } from './manifest.js';
import { resolveStageDispatch } from './stage-dispatch.js';
import { isTerminalStage, stageForStatus } from './stages.js';

export interface StageHandoffReceiptSummary {
  requestId: string;
  entryId: string;
  agentId: string;
  stage: string;
  state: StageDispatchReceipt['state'];
  turnId?: string;
  error?: string;
}

export interface StageHandoffDescriptor {
  entryId: string;
  stage: string;
  role: 'agent' | 'reviewer' | null;
  /** Template default agent for this stage (manual hand-off recipient). */
  defaultAgentId: string | null;
  /** Template default agent on the stage entered by `start` (typically in_progress). */
  startDefaultAgentId: string | null;
  /** Template auto policy on the stage entered by `start`. */
  startDefaultAuto: boolean;
  /**
   * Effective auto for the current stage entry: the recorded `dispatchAuto ||
   * dispatchOverride`. False for unrecorded fallback entries, which are manual only.
   */
  auto: boolean;
  /** Configured template auto policy for this stage (may differ from `auto`). */
  templateAuto: boolean;
  /** Recipient recorded on the current stage entry; automatic requests go here. */
  recordedTargetId: string | null;
  canDispatch: boolean;
  reason?: string;
  /** True when entryId is an unrecorded~ fallback token. */
  manualFallback: boolean;
  /** True when the stage entry was recorded with --no-dispatch suppression. */
  suppressed: boolean;
  latestReceipt?: StageHandoffReceiptSummary;
}

export interface BuildStageHandoffInput {
  ticketId: string;
  status: string;
  templateId: string | null;
  manifest: TemplateManifest;
  chatEvents: ChatEvent[];
  definitions: AgentDefinition[];
  /** Optional preloaded stage entry; when omitted, reads from events DB. */
  stageEntry?: StageEntryEvent | null;
}

function summarizeReceipt(receipt: StageDispatchReceipt): StageHandoffReceiptSummary {
  return {
    requestId: receipt.requestId,
    entryId: receipt.entryId,
    agentId: receipt.agentId,
    stage: receipt.stage,
    state: receipt.state,
    ...(receipt.turnId ? { turnId: receipt.turnId } : {}),
    ...(receipt.error ? { error: receipt.error } : {}),
  };
}

function latestReceiptForEntry(
  events: ChatEvent[],
  entryId: string,
): StageDispatchReceipt | null {
  let latest: StageDispatchReceipt | null = null;
  let latestSeq = -1;
  for (const requestId of listStageDispatchRequestIds(events)) {
    const receipt = readStageDispatchReceipt(events, requestId);
    if (!receipt || receipt.entryId !== entryId) continue;
    let maxSeq = 0;
    for (const event of events) {
      if (event.kind !== 'stage.dispatch' && event.kind !== 'stage.dispatch.state') continue;
      const p = event.payload as { requestId?: string };
      if (p.requestId !== requestId) continue;
      maxSeq = Math.max(maxSeq, event.seq);
    }
    if (maxSeq >= latestSeq) {
      latestSeq = maxSeq;
      latest = receipt;
    }
  }
  return latest;
}

function agentUnavailableReason(
  agentId: string | null | undefined,
  definitions: AgentDefinition[],
): string | null {
  if (!agentId) return null;
  const def = definitions.find((d) => d.id === agentId);
  if (!def) return `Agent @${agentId} is not defined`;
  if (def.respondsTo === 'none') return `Agent @${agentId} is disabled`;
  return null;
}

function resolveEntryIdentity(
  ticketId: string,
  status: string,
  templateId: string | null,
  stageEntry: StageEntryEvent | null | undefined,
): { entryId: string; manualFallback: boolean; entry: StageEntryEvent | null } {
  const entry = stageEntry === undefined ? latestStageEntryForTicket(ticketId) : stageEntry;
  if (stageEntryMatchesStatus(entry, status)) {
    return { entryId: entry!.eventId, manualFallback: false, entry };
  }
  const latestEventId = entry?.eventId ?? null;
  return {
    entryId: buildManualFallbackEntryId(status, templateId, latestEventId),
    manualFallback: true,
    entry: null,
  };
}

/**
 * Pure stage-handoff descriptor from ticket status, template policy, chat events,
 * and stage-entry identity. Never calls buildShow or touches the broker.
 */
export function buildStageHandoffDescriptor(input: BuildStageHandoffInput): StageHandoffDescriptor {
  const stage = stageForStatus(input.status);
  const templateDefault = resolveStageDispatch(input.manifest, stage);
  const { entryId, manualFallback, entry } = resolveEntryIdentity(
    input.ticketId,
    input.status,
    input.templateId,
    input.stageEntry,
  );

  const latestReceipt = latestReceiptForEntry(input.chatEvents, entryId);
  const role = templateDefault?.role ?? null;
  const defaultAgentId = templateDefault?.agentId ?? null;
  const templateAuto = templateDefault?.auto ?? false;
  // Automatic requests resolve to the entry's recorded target and policy (the
  // server refuses anything else), so recovery and labels must follow the entry,
  // not the template: a `start --agent Y` override on an auto:false stage is auto.
  const recordedTargetId = entry?.dispatchTarget ?? null;
  const suppressed = Boolean(entry?.dispatchSuppressed);
  const auto = Boolean(
    entry &&
      recordedTargetId &&
      !suppressed &&
      (entry.dispatchAuto === true || entry.dispatchOverride),
  );
  const startDefault = resolveStageDispatch(input.manifest, 'in_progress');
  const startDefaultAgentId = startDefault?.agentId ?? null;
  const startDefaultAuto = startDefault?.auto ?? false;

  if (isTerminalStage(stage)) {
    return {
      entryId,
      stage,
      role,
      defaultAgentId,
      startDefaultAgentId,
      startDefaultAuto,
      auto,
      templateAuto,
      recordedTargetId,
      canDispatch: false,
      reason: 'Terminal stages do not accept stage handoffs',
      manualFallback,
      suppressed,
      ...(latestReceipt ? { latestReceipt: summarizeReceipt(latestReceipt) } : {}),
    };
  }

  // The primary hand-off goes to the recorded target on automatic entries.
  const primaryAgentId = auto ? recordedTargetId : defaultAgentId;
  const unavailable = agentUnavailableReason(primaryAgentId, input.definitions);
  const receiptActive =
    latestReceipt &&
    (latestReceipt.state === 'queued' || latestReceipt.state === 'running');

  let canDispatch = true;
  let reason: string | undefined;

  if (receiptActive) {
    canDispatch = false;
    reason = `Handoff ${latestReceipt.state} (${latestReceipt.requestId})`;
  } else if (!primaryAgentId && !manualFallback) {
    canDispatch = true;
  } else if (unavailable) {
    canDispatch = false;
    reason = unavailable;
  }

  return {
    entryId,
    stage,
    role,
    defaultAgentId,
    startDefaultAgentId,
    startDefaultAuto,
    auto,
    templateAuto,
    recordedTargetId,
    canDispatch,
    ...(reason ? { reason } : {}),
    manualFallback,
    suppressed,
    ...(latestReceipt ? { latestReceipt: summarizeReceipt(latestReceipt) } : {}),
  };
}

export function formatStageHandoffLine(descriptor: StageHandoffDescriptor): string {
  const receipt = descriptor.latestReceipt;
  if (receipt) {
    const target = receipt.agentId ? `@${receipt.agentId}` : 'agent';
    if (receipt.state === 'queued' || receipt.state === 'running') {
      return `Agent: ${receipt.state} handoff to ${target}`;
    }
    if (receipt.state === 'completed') {
      return `Agent: completed handoff to ${target} (turn finished — ticket not done)`;
    }
    if (receipt.state === 'failed' || receipt.state === 'cancelled' || receipt.state === 'interrupted') {
      const detail = receipt.error ? ` — ${receipt.error}` : '';
      return `Agent: ${receipt.state} handoff to ${target}${detail}`;
    }
    if (receipt.state === 'superseded') {
      return `Agent: superseded handoff (${receipt.requestId})`;
    }
  }

  if (!descriptor.canDispatch) {
    return `Agent: ${descriptor.reason ?? 'handoff unavailable'}`;
  }

  if (descriptor.suppressed && descriptor.recordedTargetId) {
    return `Agent: automatic handoff to @${descriptor.recordedTargetId} suppressed (--no-dispatch); hand off manually when ready`;
  }

  if (descriptor.auto && descriptor.recordedTargetId) {
    return `Agent: automatic handoff to @${descriptor.recordedTargetId} on stage entry`;
  }

  if (descriptor.defaultAgentId) {
    return `Agent: hand off to @${descriptor.defaultAgentId} when ready`;
  }

  return 'Agent: select an agent and hand off work manually';
}
