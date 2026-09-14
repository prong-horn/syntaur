/**
 * v2 lifecycle verbs — explicit stage moves and flags (§6.1).
 */

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expandHome } from '../utils/paths.js';
import { writeFileForce } from '../utils/fs.js';
import { readConfig } from '../utils/config.js';
import { isValidSlug } from '../utils/slug.js';
import { nowTimestamp } from '../utils/timestamp.js';
import { resolveTicketById } from '../utils/ticket-resolver.js';
import { isTicketId } from '../utils/ticket-ids.js';
import { parseTicketFrontmatter, updatePlanBlock, updateTicketFile } from './frontmatter.js';
import {
  emitFlagged,
  emitMoved,
  emitPlanApproved,
  emitUnflagged,
} from './event-emit.js';
import type { TicketStatus } from './types.js';
import { buildGateContext } from '../ticket-templates/context.js';
import { evaluateGate, gatesForVerb, hasPlanRole, type GateContext } from '../ticket-templates/gates.js';
import type { GateId, StageId, TemplateManifest, VerbWithGates } from '../ticket-templates/manifest.js';
import { planDigest } from '../ticket-templates/plan-facts.js';
import { isTerminalStage, stageForStatus } from '../ticket-templates/stages.js';
import { latestPlanRevision, planStemFromPath } from '../ticket-templates/roles.js';
import { loadTemplate, resolveTemplateForTicket } from '../ticket-templates/registry.js';
import { planRoleFile } from '../ticket-templates/manifest.js';
import { syntaurRoot } from '../utils/paths.js';

export type MoveVerb = 'plan' | 'approve' | 'start' | 'review' | 'done' | 'drop' | 'reopen';
export type FlagVerb = 'block' | 'unblock' | 'park' | 'unpark';

export interface VerbOptions {
  force?: boolean;
  agent?: string;
  reason?: string;
  cwd?: string;
  dir?: string;
  project?: string;
}

export interface MoveTicketResult {
  ticketId: string;
  from: TicketStatus;
  to: TicketStatus;
  verb: MoveVerb;
  actor: string;
  forced: boolean;
  planApproved?: boolean;
}

export class VerbRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VerbRefusedError';
  }
}

export class GateFailedError extends Error {
  readonly next: string;

  constructor(message: string, next: string) {
    super(message);
    this.name = 'GateFailedError';
    this.next = next;
  }
}

const VERB_TARGET: Record<Exclude<MoveVerb, 'reopen'>, StageId | 'dropped'> = {
  plan: 'planning',
  approve: 'ready',
  start: 'in_progress',
  review: 'review',
  done: 'done',
  drop: 'dropped',
};

async function resolveTicketDir(
  ticketId: string,
  options: VerbOptions,
): Promise<{ ticketDir: string; projectSlug: string | null }> {
  const config = await readConfig();
  const baseDir = options.dir ? expandHome(options.dir) : config.defaultProjectDir;

  if (!isTicketId(ticketId)) {
    throw new VerbRefusedError(`Ticket "${ticketId}" is not a valid ticket id.`);
  }

  if (options.project) {
    if (!isValidSlug(options.project)) {
      throw new VerbRefusedError(`Invalid project slug "${options.project}".`);
    }
    const resolved = await resolveTicketById(baseDir, ticketId);
    if (!resolved || resolved.projectSlug !== options.project) {
      throw new VerbRefusedError(`Ticket "${ticketId}" not found in project "${options.project}".`);
    }
    return { ticketDir: resolved.ticketDir, projectSlug: options.project };
  }

  const resolved = await resolveTicketById(baseDir, ticketId);
  if (!resolved) {
    throw new VerbRefusedError(`Ticket "${ticketId}" not found.`);
  }
  return {
    ticketDir: resolved.ticketDir,
    projectSlug: resolved.standalone ? null : resolved.projectSlug,
  };
}

/** Actor: explicit --agent, else bound session agent, else human. */
export async function resolveVerbActor(options: VerbOptions): Promise<string> {
  if (options.agent) return options.agent;
  try {
    const cwd = options.cwd ?? process.cwd();
    const { initSessionDb } = await import('../dashboard/session-db.js');
    const { resolveSessionEngagement } = await import('../utils/engagement-binding.js');
    initSessionDb();
    const se = await resolveSessionEngagement(cwd);
    if (se?.session.id) {
      const { getSessionById } = await import('../dashboard/agent-sessions.js');
      const row = getSessionById(se.session.id);
      if (row?.agent) return row.agent;
    }
  } catch {
    /* no session db */
  }
  return 'human';
}

function manifestHasStage(manifest: TemplateManifest, stage: StageId): boolean {
  return manifest.stages.some((s) => s.id === stage);
}

function previousStageInSubset(
  manifest: TemplateManifest,
  target: StageId,
): StageId | null {
  const subset = manifest.stages.map((s) => s.id);
  const idx = subset.indexOf(target);
  if (idx <= 0) return null;
  return subset[idx - 1] ?? null;
}

function stageBeforeDone(manifest: TemplateManifest): StageId {
  const subset = manifest.stages.map((s) => s.id);
  const doneIdx = subset.indexOf('done');
  if (doneIdx <= 0) {
    return subset[subset.length - 1] ?? 'backlog';
  }
  return subset[doneIdx - 1];
}

function isFileOnlyVerb(manifest: TemplateManifest, verb: 'plan' | 'approve'): boolean {
  if (!hasPlanRole(manifest)) return false;
  if (verb === 'plan') return !manifestHasStage(manifest, 'planning');
  return !manifestHasStage(manifest, 'planning') && !manifestHasStage(manifest, 'ready');
}

function refuse(verb: string, ticketId: string, message: string): never {
  throw new VerbRefusedError(`Cannot ${verb} ${ticketId}: ${message}`);
}

async function assertGates(
  verb: VerbWithGates | 'approve',
  ticketId: string,
  ctx: GateContext,
  extraGateIds: GateId[] = [],
): Promise<void> {
  const gateIds = [
    ...extraGateIds,
    ...(verb === 'approve'
      ? [...new Set<GateId>(['plan-exists', ...gatesForVerb(ctx.manifest, 'approve')])]
      : gatesForVerb(ctx.manifest, verb as VerbWithGates)),
  ];

  for (const gateId of gateIds) {
    const result = await evaluateGate(gateId, ctx);
    if (!result.pass) {
      const hint = result.hint.replace('<ID>', ticketId);
      const reason = result.reason ?? 'gate check failed';
      throw new GateFailedError(
        `Cannot ${verb} ${ticketId}: ${gateId} — ${reason}. Next: ${hint}`,
        hint,
      );
    }
  }
}

async function resolvePlanStem(ticketDir: string, fm: GateContext['fm']): Promise<string> {
  const templateId = resolveTemplateForTicket(fm);
  const manifest = await loadTemplate(syntaurRoot(), templateId);
  const role = planRoleFile(manifest);
  if (!role) throw new VerbRefusedError(`template ${templateId} has no plan role`);
  return planStemFromPath(role.path);
}

export async function moveTicket(
  ticketId: string,
  verb: MoveVerb,
  options: VerbOptions = {},
): Promise<MoveTicketResult> {
  const { ticketDir, projectSlug } = await resolveTicketDir(ticketId, options);
  const ticketPath = resolve(ticketDir, 'ticket.md');
  const content = await readFile(ticketPath, 'utf-8');
  const fm = parseTicketFrontmatter(content);
  const ctx = await buildGateContext(ticketDir);
  const manifest = ctx.manifest;
  const actor = await resolveVerbActor(options);
  const forced = options.force ?? false;

  let current: TicketStatus;
  try {
    current = stageForStatus(fm.status);
  } catch {
    refuse(verb, ticketId, `unknown stage ${fm.status}`);
  }

  if (verb === 'drop') {
    if (!options.reason?.trim()) {
      refuse(verb, ticketId, 'reason is required');
    }
    if (isTerminalStage(current)) {
      refuse(verb, ticketId, `ticket is in ${current}, drop applies from active stages`);
    }
    if (!forced) {
      // drop has no template gates
    }
    const to = 'dropped' as TicketStatus;
    const now = nowTimestamp();
    const updated = updateTicketFile(content, { status: to, updated: now });
    await writeFileForce(ticketPath, updated);
    emitMoved({
      ticketId: fm.id,
      projectSlug,
      from: current,
      to,
      verb,
      by: actor,
      forced,
      reason: options.reason!.trim(),
      at: now,
    });
    return { ticketId: fm.id, from: current, to, verb, actor, forced };
  }

  if (verb === 'reopen') {
    if (current !== 'done' && current !== 'dropped') {
      refuse(verb, ticketId, `ticket is in ${current}, reopen applies from done or dropped`);
    }
    const to = stageBeforeDone(manifest);
    const now = nowTimestamp();
    const updated = updateTicketFile(content, { status: to, updated: now });
    await writeFileForce(ticketPath, updated);
    emitMoved({
      ticketId: fm.id,
      projectSlug,
      from: current,
      to,
      verb,
      by: actor,
      forced,
      at: now,
    });
    return { ticketId: fm.id, from: current, to, verb, actor, forced };
  }

  if ((verb === 'plan' || verb === 'approve') && !hasPlanRole(manifest)) {
    refuse(verb, ticketId, `template ${manifest.id} has no plan role`);
  }

  const target = VERB_TARGET[verb as Exclude<MoveVerb, 'reopen'>];
  const fileOnly = (verb === 'plan' || verb === 'approve') && isFileOnlyVerb(manifest, verb);

  if (!fileOnly && !manifestHasStage(manifest, target as StageId)) {
    refuse(verb, ticketId, `template ${manifest.id} has no ${target} stage`);
  }

  const requiredFrom = fileOnly ? null : previousStageInSubset(manifest, target as StageId);
  if (requiredFrom !== null && current !== requiredFrom) {
    refuse(
      verb,
      ticketId,
      `ticket is in ${current}, ${verb} applies from ${requiredFrom}`,
    );
  }

  if (!forced) {
    if (verb === 'approve') {
      await assertGates('approve', ticketId, ctx);
    } else if (verb !== 'plan' || !fileOnly) {
      await assertGates(verb as VerbWithGates, ticketId, ctx);
    }
  }

  let updatedContent = content;
  const now = nowTimestamp();
  let planApproved = false;

  if (verb === 'approve') {
    const stem = await resolvePlanStem(ticketDir, fm);
    const planFile = fm.plan.file ?? (await latestPlanRevision(ticketDir, stem));
    if (!planFile) {
      refuse(verb, ticketId, 'no plan file found');
    }
    const planContent = await readFile(resolve(ticketDir, planFile), 'utf-8');
    const digest = planDigest(planContent);
    updatedContent = updatePlanBlock(content, {
      file: planFile,
      approvedDigest: digest,
      approvedAt: now,
      approvedBy: actor,
    });
    emitPlanApproved({
      ticketId: fm.id,
      projectSlug,
      actor,
      file: planFile,
      digest,
      at: now,
    });
    planApproved = true;
  }

  const toStatus: TicketStatus = fileOnly ? current : (target as TicketStatus);
  if (!fileOnly) {
    updatedContent = updateTicketFile(updatedContent, { status: toStatus, updated: now });
  } else {
    updatedContent = updateTicketFile(updatedContent, { updated: now });
  }

  await writeFileForce(ticketPath, updatedContent);

  if (!fileOnly && current !== toStatus) {
    emitMoved({
      ticketId: fm.id,
      projectSlug,
      from: current,
      to: toStatus,
      verb,
      by: actor,
      forced,
      at: now,
    });
  }

  return {
    ticketId: fm.id,
    from: current,
    to: toStatus,
    verb,
    actor,
    forced,
    ...(planApproved ? { planApproved: true } : {}),
  };
}

export async function unapproveTicket(
  ticketId: string,
  options: VerbOptions = {},
): Promise<void> {
  const { ticketDir } = await resolveTicketDir(ticketId, options);
  const ticketPath = resolve(ticketDir, 'ticket.md');
  const content = await readFile(ticketPath, 'utf-8');
  const now = nowTimestamp();
  const updated = updatePlanBlock(content, {
    approvedDigest: null,
    approvedAt: null,
    approvedBy: null,
  });
  await writeFileForce(ticketPath, updateTicketFile(updated, { updated: now }));
}

export async function flagTicket(
  ticketId: string,
  flag: FlagVerb,
  reason: string | null,
  options: VerbOptions = {},
): Promise<void> {
  const { ticketDir, projectSlug } = await resolveTicketDir(ticketId, options);
  const ticketPath = resolve(ticketDir, 'ticket.md');
  const content = await readFile(ticketPath, 'utf-8');
  const fm = parseTicketFrontmatter(content);
  const actor = await resolveVerbActor(options);
  const now = nowTimestamp();

  if (flag === 'block' || flag === 'park') {
    const trimmed = reason?.trim();
    if (!trimmed) {
      refuse(flag, ticketId, 'reason is required');
    }
    const field = flag === 'block' ? 'blocked' : 'parked';
    const updated = updateTicketFile(content, {
      [field]: trimmed,
      updated: now,
    } as Partial<ReturnType<typeof parseTicketFrontmatter>>);
    await writeFileForce(ticketPath, updated);
    emitFlagged({
      ticketId: fm.id,
      projectSlug,
      actor,
      flag: flag === 'block' ? 'blocked' : 'parked',
      reason: trimmed!,
      at: now,
    });
    return;
  }

  const field = flag === 'unblock' ? 'blocked' : 'parked';
  const updated = updateTicketFile(content, {
    [field]: null,
    updated: now,
  } as Partial<ReturnType<typeof parseTicketFrontmatter>>);
  await writeFileForce(ticketPath, updated);
  emitUnflagged({
    ticketId: fm.id,
    projectSlug,
    actor,
    flag: flag === 'unblock' ? 'blocked' : 'parked',
    at: now,
  });
}

/** @internal exported for tests */
export const _internal = {
  previousStageInSubset,
  stageBeforeDone,
  isFileOnlyVerb,
  manifestHasStage,
};
