import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { ResolvedTicket } from '../utils/ticket-resolver.js';
import { getStageEntryById, latestStageEntryForTicket } from '../db/events-db.js';
import { parseTicketFrontmatter } from '../lifecycle/frontmatter.js';
import { loadTemplate, resolveTemplateForTicket } from '../ticket-templates/registry.js';
import { resolveStageDispatch } from '../ticket-templates/stage-dispatch.js';
import type { StageId } from '../ticket-templates/manifest.js';
import { stageForStatus } from '../ticket-templates/stages.js';
import { withTicketMutationLock } from '../utils/ticket-mutation-lock.js';
import { buildShow, renderShowText } from '../ticket-templates/show.js';
import { logRoleFile } from '../ticket-templates/manifest.js';
import { syntaurRoot } from '../utils/paths.js';
import {
  buildManualFallbackEntryId,
  isUuidEntryId,
} from '../lifecycle/stage-entry.js';

import { loadAgentDefinitions, type LoadAgentDefinitionsResult } from './agents.js';
import {
  readStageDispatchReceipt,
  type StageDispatchReceipt,
  type StageDispatchReceiptState,
} from './stage-dispatch-state.js';
import type { ChatEvent, TurnTrigger } from './types.js';
import { HUMAN_AGENT_ID } from './types.js';

export interface StageDispatchInput {
  ticket: ResolvedTicket;
  entryId: string;
  requestId: string;
  agentId?: string;
  source: 'automatic' | 'manual';
  requestedBy?: string;
}

export interface StageDispatchAcceptResult {
  requestId: string;
  state: StageDispatchReceiptState;
  agentId: string;
  entryId?: string;
  turnId?: string;
  error?: string;
}

export interface StageDispatchAcceptanceRecord {
  requestId: string;
  entryId: string;
  agentId: string;
  stage: string;
  role: 'agent' | 'reviewer';
  source: 'automatic' | 'manual';
  policyDigest: string;
}

export interface StageQueueMeta {
  entryId: string;
  policyDigest: string;
  role: 'agent' | 'reviewer';
  source: 'automatic' | 'manual';
}

export class StageDispatchError extends Error {
  constructor(
    message: string,
    readonly status = 409,
  ) {
    super(message);
    this.name = 'StageDispatchError';
  }
}

export function policyDigest(input: {
  templateId: string;
  stage: string;
  role: string;
  agentId: string;
  auto: boolean;
  instructions: string;
}): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        templateId: input.templateId,
        stage: input.stage,
        role: input.role,
        agentId: input.agentId,
        auto: input.auto,
        instructions: input.instructions,
      }),
    )
    .digest('hex');
}

export function validateRequestId(
  source: 'automatic' | 'manual',
  requestId: string,
  entryId: string,
): void {
  if (source !== 'automatic' && source !== 'manual') {
    throw new StageDispatchError('invalid dispatch source', 400);
  }
  if (source === 'automatic') {
    if (requestId !== `auto~${entryId}`) {
      throw new StageDispatchError('automatic requestId must be auto~<entryId>', 400);
    }
  } else if (!isUuidEntryId(requestId)) {
    throw new StageDispatchError('manual requestId must be a UUID', 400);
  }
  if (source === 'automatic' && entryId.startsWith('unrecorded~')) {
    throw new StageDispatchError('automatic dispatch requires a recorded stage entry', 409);
  }
}

export function buildReviewerPrompt(
  ticketId: string,
  manifest: Awaited<ReturnType<typeof loadTemplate>>,
  agentId: string,
  instructions: string,
  showText: string,
): string {
  const logRole = logRoleFile(manifest);
  const reviewCmd = logRole?.entryTypes.includes('review')
    ? `syntaur log ${ticketId} -t review --agent ${agentId} --verdict approve|changes --open high=<n>,medium=<n> "<body>"`
    : null;
  const gateNote = reviewCmd
    ? `Record your verdict with:\n${reviewCmd}`
    : 'This template has no review-capable log role; report findings in chat without fabricating a passing gate.';
  return `${instructions}\n\n${showText}\n\nYou are reviewing work on ticket ${ticketId}. Inspect the implementation, run tests, and report concrete findings.\n${gateNote}`;
}

export interface StageDispatchQueueEntry {
  requestId: string;
  entryId: string;
  agentId: string;
  role: 'agent' | 'reviewer';
  source: 'automatic' | 'manual';
  stage: string;
  policyDigest: string;
  trigger: TurnTrigger;
  stageMeta: StageQueueMeta;
}

export function stageQueueEntriesMatch(
  a: StageDispatchQueueEntry,
  b: StageDispatchQueueEntry,
): boolean {
  return (
    a.requestId === b.requestId &&
    a.entryId === b.entryId &&
    a.agentId === b.agentId &&
    a.role === b.role &&
    a.source === b.source &&
    a.policyDigest === b.policyDigest &&
    a.stage === b.stage
  );
}

function parseAcceptance(event: ChatEvent): StageDispatchAcceptanceRecord | null {
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
    role: p.role as 'agent' | 'reviewer',
    source: p.source as 'automatic' | 'manual',
    policyDigest: p.policyDigest,
  };
}

export function findStageDispatchAcceptance(
  events: ChatEvent[],
  requestId: string,
): StageDispatchAcceptanceRecord | null {
  for (const event of events) {
    if (event.kind !== 'stage.dispatch') continue;
    const p = event.payload as { requestId?: string };
    if (p.requestId !== requestId) continue;
    return parseAcceptance(event);
  }
  return null;
}

export function acceptanceMatchesInput(
  acceptance: StageDispatchAcceptanceRecord,
  input: StageDispatchInput,
): boolean {
  return (
    acceptance.entryId === input.entryId &&
    acceptance.source === input.source &&
    (input.agentId === undefined || acceptance.agentId === input.agentId)
  );
}

function isUnrecordedEntryId(entryId: string): boolean {
  return entryId.startsWith('unrecorded~');
}

function verifyManualUnrecordedEntryId(
  entryId: string,
  status: string,
  templateId: string,
  latestEventId: string | null,
): void {
  const expected = buildManualFallbackEntryId(status, templateId, latestEventId);
  if (entryId !== expected) {
    throw new StageDispatchError('stale manual fallback entry token', 409);
  }
}

export async function resolveStageDispatchTarget(
  ticket: ResolvedTicket,
  entryId: string,
  source: 'automatic' | 'manual',
  agentIdOverride?: string,
  root?: string,
): Promise<{
  entry: NonNullable<ReturnType<typeof getStageEntryById>> | null;
  stage: StageId;
  target: NonNullable<ReturnType<typeof resolveStageDispatch>>;
  manifest: Awaited<ReturnType<typeof loadTemplate>>;
  definitions: LoadAgentDefinitionsResult['definitions'];
  templateDefault: ReturnType<typeof resolveStageDispatch>;
}> {
  const home = root ?? syntaurRoot();
  if (source === 'automatic' && !isUuidEntryId(entryId)) {
    throw new StageDispatchError('automatic dispatch requires a UUID entryId', 409);
  }
  if (source === 'manual' && !isUuidEntryId(entryId) && !isUnrecordedEntryId(entryId)) {
    throw new StageDispatchError('manual entryId must be a UUID or unrecorded fallback token', 400);
  }

  const ticketMd = await readFile(resolve(ticket.ticketDir, 'ticket.md'), 'utf-8');
  const fm = parseTicketFrontmatter(ticketMd);
  const status = stageForStatus(fm.status);
  const manifest = await loadTemplate(home, resolveTemplateForTicket(fm));
  const { definitions } = await loadAgentDefinitions(home);

  let entry = getStageEntryById(ticket.id, entryId);
  let stage = status;

  if (isUnrecordedEntryId(entryId)) {
    if (source !== 'manual') {
      throw new StageDispatchError('automatic dispatch requires a recorded stage entry', 409);
    }
    const latest = latestStageEntryForTicket(ticket.id);
    verifyManualUnrecordedEntryId(
      entryId,
      status,
      manifest.id,
      latest?.eventId ?? null,
    );
    if (latest && latest.stage === status) {
      throw new StageDispatchError('recorded stage entry exists for current stage', 409);
    }
    entry = null;
  } else {
    if (!entry) throw new StageDispatchError('unknown stage entry', 409);
    stage = entry.stage as StageId;
    if (entry.stage !== status) {
      throw new StageDispatchError('stale stage entry', 409);
    }
    const currentEntry = latestStageEntryForTicket(ticket.id);
    if (!currentEntry || currentEntry.eventId !== entryId) {
      throw new StageDispatchError('stale stage entry', 409);
    }
  }

  const templateDefault = resolveStageDispatch(manifest, stage, undefined);

  let target: ReturnType<typeof resolveStageDispatch>;
  if (source === 'automatic') {
    if (!entry) {
      throw new StageDispatchError('automatic dispatch requires a recorded stage entry', 409);
    }
    if (agentIdOverride && agentIdOverride !== entry.dispatchTarget) {
      throw new StageDispatchError('automatic agentId conflicts with recorded target', 409);
    }
    if (!entry.dispatchAuto && !entry.dispatchOverride) {
      throw new StageDispatchError('automatic dispatch not authorized for this entry', 409);
    }
    if (!entry.dispatchTarget) {
      throw new StageDispatchError('no dispatch target on entry', 409);
    }
    target = resolveStageDispatch(manifest, stage, entry.dispatchTarget);
  } else {
    const chosen = agentIdOverride ?? templateDefault?.agentId;
    if (!chosen) {
      throw new StageDispatchError('manual dispatch requires agentId when no default target', 400);
    }
    target = resolveStageDispatch(manifest, stage, chosen);
  }

  if (!target) throw new StageDispatchError('no stage dispatch target', 409);

  const def = definitions.find((d) => d.id === target!.agentId);
  if (!def || def.id !== target.agentId) {
    throw new StageDispatchError(`agent "${target.agentId}" is unavailable`, 409);
  }
  if (def.respondsTo === 'none') {
    throw new StageDispatchError(`agent "${target.agentId}" is disabled`, 409);
  }

  return { entry, stage: stage as StageId, target, manifest, definitions, templateDefault };
}

export function computePolicyDigest(
  manifest: Awaited<ReturnType<typeof loadTemplate>>,
  stage: StageId,
  instructions: string,
  templateDefault: ReturnType<typeof resolveStageDispatch>,
): string {
  const basis = templateDefault ?? {
    stage,
    role: 'agent' as const,
    agentId: '',
    auto: false,
    instructions,
  };
  return policyDigest({
    templateId: manifest.id,
    stage,
    role: basis.role,
    agentId: basis.agentId,
    auto: basis.auto,
    instructions,
  });
}

export async function buildStageShowText(ticket: ResolvedTicket, root?: string): Promise<string> {
  const showModel = await buildShow(root ?? syntaurRoot(), ticket.ticketDir);
  return renderShowText(showModel);
}

export async function buildStageTurnPrompt(
  ticket: ResolvedTicket,
  target: NonNullable<ReturnType<typeof resolveStageDispatch>>,
  manifest: Awaited<ReturnType<typeof loadTemplate>>,
  root?: string,
): Promise<string> {
  const showText = await buildStageShowText(ticket, root);
  if (target.role === 'reviewer') {
    return buildReviewerPrompt(
      ticket.id,
      manifest,
      target.agentId,
      target.instructions,
      showText,
    );
  }
  return `${target.instructions}\n\n${showText}`;
}

export async function prepareStageQueueEntry(
  ticket: ResolvedTicket,
  input: StageDispatchInput,
  root?: string,
): Promise<StageDispatchQueueEntry> {
  validateRequestId(input.source, input.requestId, input.entryId);
  const { target, manifest, templateDefault } = await resolveStageDispatchTarget(
    ticket,
    input.entryId,
    input.source,
    input.agentId,
    root,
  );

  const digest = computePolicyDigest(
    manifest,
    target.stage,
    target.instructions,
    templateDefault,
  );

  return {
    requestId: input.requestId,
    entryId: input.entryId,
    agentId: target.agentId,
    role: target.role,
    source: input.source,
    stage: target.stage,
    policyDigest: digest,
    trigger: { kind: 'stage', requestId: input.requestId },
    stageMeta: {
      entryId: input.entryId,
      policyDigest: digest,
      role: target.role,
      source: input.source,
    },
  };
}

export function stageItemScope(requestId: string): string {
  return `stage~${requestId}`;
}

export function stageItemId(requestId: string, ordinal = 0): string {
  return `${stageItemScope(requestId)}~${ordinal}`;
}

export function reconcileStageReceipt(
  events: ChatEvent[],
  requestId: string,
): StageDispatchReceipt | null {
  return readStageDispatchReceipt(events, requestId);
}

export function mintManualRequestId(): string {
  return randomUUID();
}

export async function revalidateStageEntry(
  ticket: ResolvedTicket,
  entryId: string,
): Promise<boolean> {
  return withTicketMutationLock(resolve(ticket.ticketDir, 'ticket.md'), async () => {
    try {
      await resolveStageDispatchTarget(ticket, entryId, 'automatic');
      return true;
    } catch {
      return false;
    }
  });
}

export type StageDriveCheck =
  | { ok: true; promptText: string }
  | { ok: false; state: Extract<StageDispatchReceiptState, 'superseded' | 'failed'>; error?: string };

function stageDriveFailureState(err: unknown): Extract<StageDispatchReceiptState, 'superseded' | 'failed'> {
  if (err instanceof StageDispatchError) {
    const msg = err.message.toLowerCase();
    if (
      msg.includes('stale') ||
      msg.includes('conflict') ||
      msg.includes('detach') ||
      msg.includes('policy') ||
      msg.includes('recipient') ||
      msg.includes('unavailable') ||
      msg.includes('disabled')
    ) {
      return 'superseded';
    }
    if (err.status === 409) return 'superseded';
  }
  return 'failed';
}

/** Authoritative preflight for queued stage work — no adapter I/O. */
export async function validateStageDrive(
  ticket: ResolvedTicket,
  meta: StageQueueMeta,
  agentId: string,
  attachedAgents: readonly string[],
  root?: string,
): Promise<StageDriveCheck> {
  try {
    const { target, manifest, stage } = await resolveStageDispatchTarget(
      ticket,
      meta.entryId,
      meta.source,
      meta.source === 'manual' ? agentId : undefined,
      root,
    );
    if (target.agentId !== agentId) {
      return { ok: false, state: 'superseded', error: 'dispatch recipient changed' };
    }
    const digest = computePolicyDigest(
      manifest,
      stage,
      target.instructions,
      resolveStageDispatch(manifest, stage, undefined),
    );
    if (digest !== meta.policyDigest) {
      return { ok: false, state: 'superseded', error: 'stage policy changed' };
    }
    if (!attachedAgents.includes(agentId)) {
      return { ok: false, state: 'superseded', error: 'target agent detached' };
    }
    const promptText = await buildStageTurnPrompt(ticket, target, manifest, root);
    return { ok: true, promptText };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, state: stageDriveFailureState(err), error: message };
  }
}

export const STAGE_DISPATCH_REQUESTED_BY = HUMAN_AGENT_ID;
