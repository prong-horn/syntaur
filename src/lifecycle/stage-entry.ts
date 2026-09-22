import { createHash, randomUUID } from 'node:crypto';
import type { ResolvedSession } from '../utils/session-id.js';
import { insertLiveEventOrThrow, type StageEntryEvent } from '../db/events-db.js';
import { switchSessionStage } from '../utils/engagement-binding.js';
import { getOpenEngagement } from '../db/engagement-db.js';
import { getSessionById } from '../dashboard/agent-sessions.js';
import { initSessionDb } from '../dashboard/session-db.js';
import type { TemplateManifest } from '../ticket-templates/manifest.js';
import {
  resolveStageDispatch,
  type StageDispatchTarget,
  StageDispatchPolicyError,
} from '../ticket-templates/stage-dispatch.js';
import type { StageId } from '../ticket-templates/manifest.js';
import { isTerminalStage } from '../ticket-templates/stages.js';
import { loadAgentDefinitions } from '../chat/agents.js';
import { syntaurRoot } from '../utils/paths.js';
import { emitDispatched } from './event-emit.js';

export type DispatchSource = 'automatic' | 'manual';

export interface DispatchResult {
  state: 'queued' | 'failed' | 'offline' | 'unknown' | 'skipped' | 'manual-only' | 'suppressed';
  requestId?: string;
  error?: string;
  warning?: string;
}

export interface StageEntryRecord {
  entryId: string;
  stage: string;
  dispatchTarget: StageDispatchTarget | null;
  dispatchOverride: boolean;
  dispatchSuppressed: boolean;
  eventType: 'created' | 'moved';
}

export interface RecordStageEntryInput {
  ticketId: string;
  projectSlug: string | null;
  actor: string;
  at: string;
  eventType: 'created' | 'moved';
  /** Destination stage after the mutation. */
  stage: string;
  manifest: TemplateManifest;
  dispatchAgent?: string;
  suppressDispatch?: boolean;
  verb?: string;
  from?: string;
  to?: string;
  forced?: boolean;
  reason?: string;
}

export interface CompleteStageEntryInput {
  ticketId: string;
  ticketDir: string;
  projectSlug: string | null;
  ticketSlug: string | null;
  entry: StageEntryRecord;
  actor: string;
  callerSession?: ResolvedSession;
  dispatch?: StageDispatchCallback;
}

export interface StageDispatchRequest {
  ticketId: string;
  ticketDir: string;
  projectSlug: string | null;
  entryId: string;
  requestId: string;
  agentId?: string;
  source: DispatchSource;
  dispatchTarget: StageDispatchTarget | null;
  dispatchOverride: boolean;
}

export interface StageEntryNotification {
  ticketId: string;
  ticketDir: string;
  projectSlug: string | null;
  entryId: string;
}

export type StageDispatchCallback = ((
  input: StageDispatchRequest,
) => Promise<DispatchResult>) & {
  notifyStageEntry?: (input: StageEntryNotification) => Promise<void>;
};

export interface StageChangeOutcome {
  stageChanged: boolean;
  entry?: StageEntryRecord;
  dispatch?: DispatchResult;
  warnings?: string[];
}

/**
 * Validate a start-override recipient before any lifecycle mutation. Throws on
 * unknown id or missing definition.
 */
export async function validateDispatchRecipient(
  agentId: string,
  root?: string,
): Promise<void> {
  const home = root ?? syntaurRoot();
  const { definitions } = await loadAgentDefinitions(home);
  const exact = definitions.find((d) => d.id === agentId);
  if (!exact) {
    throw new Error(`Unknown agent id "${agentId}"`);
  }
  if (exact.respondsTo === 'none') {
    throw new Error(`Agent "${agentId}" is disabled (respondsTo: none)`);
  }
}

export function resolveDispatchPolicy(
  manifest: TemplateManifest,
  stage: string,
  dispatchAgent?: string,
): { target: StageDispatchTarget | null; dispatchOverride: boolean } {
  if (isTerminalStage(stage as StageId | 'dropped')) {
    return { target: null, dispatchOverride: false };
  }
  const override = dispatchAgent?.trim();
  const target = resolveStageDispatch(
    manifest,
    stage as StageId | 'dropped',
    override || undefined,
  );
  const dispatchOverride = Boolean(override && target);
  return { target, dispatchOverride };
}

/**
 * Record stage-entry identity inside the ticket mutation lock after the file write.
 */
export function recordStageEntryLocked(input: RecordStageEntryInput): StageEntryRecord {
  const entryId = randomUUID();
  const { target, dispatchOverride } = resolveDispatchPolicy(
    input.manifest,
    input.stage,
    input.dispatchAgent,
  );
  const dispatchSuppressed = Boolean(input.suppressDispatch && target);

  const details: Record<string, unknown> = {
    stageEntryId: entryId,
    to: input.stage,
    ...(input.from !== undefined ? { from: input.from } : {}),
    ...(input.verb !== undefined ? { verb: input.verb } : {}),
    ...(input.forced !== undefined ? { forced: input.forced } : {}),
    ...(input.reason !== undefined ? { reason: input.reason } : {}),
    ...(target
      ? {
          dispatchTarget: target.agentId,
          dispatchRole: target.role,
          dispatchAuto: target.auto,
          dispatchOverride,
          ...(dispatchSuppressed ? { dispatchSuppressed: true } : {}),
        }
      : {}),
  };

  insertLiveEventOrThrow({
    eventId: entryId,
    ticketId: input.ticketId,
    projectSlug: input.projectSlug,
    type: input.eventType,
    actor: input.actor,
    at: input.at,
    details,
  });

  return {
    entryId,
    stage: input.stage,
    dispatchTarget: target,
    dispatchOverride,
    dispatchSuppressed,
    eventType: input.eventType,
  };
}

function automaticRequestId(entryId: string): string {
  return `auto~${entryId}`;
}

function shouldAutoDispatch(entry: StageEntryRecord): boolean {
  if (!entry.dispatchTarget) return false;
  if (entry.dispatchSuppressed) return false;
  if (isTerminalStage(entry.stage as StageId | 'dropped')) return false;
  if (entry.dispatchOverride) return true;
  return entry.dispatchTarget.auto;
}

async function notifyBrokerStageEntry(
  input: CompleteStageEntryInput,
): Promise<string | null> {
  const notify = input.dispatch?.notifyStageEntry;
  if (!notify) return null;
  try {
    await notify({
      ticketId: input.ticketId,
      ticketDir: input.ticketDir,
      projectSlug: input.projectSlug,
      entryId: input.entry.entryId,
    });
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

async function updateCallerEngagement(input: CompleteStageEntryInput): Promise<string | null> {
  const session = input.callerSession;
  if (!session) return null;
  if (session.provenance === 'WEAK') return null;
  initSessionDb();
  const row = getSessionById(session.id);
  if (!row || row.status !== 'active') return null;
  if (row.hostedBy === 'acp') return null;

  const open = getOpenEngagement(session.id);
  if (!open) return null;

  try {
    await switchSessionStage({
      sessionId: session.id,
      ticketId: input.ticketId,
      projectSlug: input.projectSlug,
      ticketSlug: input.ticketSlug,
      stage: input.entry.stage,
    });
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/**
 * After the mutation lock is released: update caller engagement and attempt dispatch.
 */
export async function completeStageEntry(
  input: CompleteStageEntryInput,
): Promise<StageChangeOutcome> {
  const warnings: string[] = [];
  const notifyWarning = await notifyBrokerStageEntry(input);
  if (notifyWarning) {
    warnings.push(`stage entry notification failed: ${notifyWarning}`);
  }
  const engagementWarning = await updateCallerEngagement(input);
  if (engagementWarning) {
    warnings.push(`engagement update failed: ${engagementWarning}`);
  }

  if (
    input.entry.dispatchSuppressed &&
    input.entry.dispatchTarget &&
    !isTerminalStage(input.entry.stage as StageId | 'dropped')
  ) {
    return {
      stageChanged: true,
      entry: input.entry,
      dispatch: { state: 'suppressed' },
      ...(warnings.length ? { warnings } : {}),
    };
  }

  if (!shouldAutoDispatch(input.entry)) {
    return {
      stageChanged: true,
      entry: input.entry,
      dispatch: { state: 'skipped' },
      ...(warnings.length ? { warnings } : {}),
    };
  }

  if (!input.dispatch) {
    return {
      stageChanged: true,
      entry: input.entry,
      dispatch: { state: 'offline', warning: 'No dispatch transport configured' },
      ...(warnings.length ? { warnings } : {}),
    };
  }

  const requestId = automaticRequestId(input.entry.entryId);
  try {
    const dispatch = await input.dispatch({
      ticketId: input.ticketId,
      ticketDir: input.ticketDir,
      projectSlug: input.projectSlug,
      entryId: input.entry.entryId,
      requestId,
      source: 'automatic',
      dispatchTarget: input.entry.dispatchTarget,
      dispatchOverride: input.entry.dispatchOverride,
    });
    if (dispatch.state === 'queued' && input.entry.dispatchTarget) {
      emitDispatched({
        ticketId: input.ticketId,
        projectSlug: input.projectSlug,
        actor: input.actor,
        agent: input.entry.dispatchTarget.agentId,
        stage: input.entry.stage,
        requestId,
        entryId: input.entry.entryId,
        source: 'automatic',
      });
    }
    return {
      stageChanged: true,
      entry: input.entry,
      dispatch,
      ...(warnings.length ? { warnings } : {}),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      stageChanged: true,
      entry: input.entry,
      dispatch: { state: 'failed', error: message },
      ...(warnings.length ? { warnings } : {}),
    };
  }
}

/**
 * When event recording fails after a successful file commit, surface partial success.
 */
export async function completeStageEntryAfterRecordFailure(
  input: Omit<CompleteStageEntryInput, 'entry'> & { stage: string; error: string },
): Promise<StageChangeOutcome> {
  const engagementWarning = await updateCallerEngagement({
    ...input,
    entry: {
      entryId: 'unrecorded',
      stage: input.stage,
      dispatchTarget: null,
      dispatchOverride: false,
      dispatchSuppressed: false,
      eventType: 'moved',
    },
  });
  const warnings = [
    `stage entry event not recorded: ${input.error}`,
    ...(engagementWarning ? [`engagement update failed: ${engagementWarning}`] : []),
  ];
  return {
    stageChanged: true,
    dispatch: { state: 'failed', error: input.error },
    warnings,
  };
}

export function buildManualFallbackEntryId(
  status: string,
  templateId: string | null,
  latestEventId: string | null,
): string {
  const digest = createHash('sha256')
    .update(
      JSON.stringify({
        status,
        template: templateId,
        latestEventId,
      }),
    )
    .digest('hex');
  return `unrecorded~${status}~${digest}`;
}

export function isUuidEntryId(entryId: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    entryId,
  );
}

export function stageEntryMatchesStatus(
  entry: StageEntryEvent | null,
  status: string,
): boolean {
  return entry !== null && entry.stage === status;
}

export { StageDispatchPolicyError };
