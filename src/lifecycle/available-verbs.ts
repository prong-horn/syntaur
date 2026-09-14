/**
 * Derive runnable lifecycle verbs for dashboard/CLI affordances (v2).
 */

import { buildGateContext } from '../ticket-templates/context.js';
import {
  evaluateVerbGates,
  firstFailingGate,
  hasPlanRole,
} from '../ticket-templates/gates.js';
import type { StageId, TemplateManifest, VerbWithGates } from '../ticket-templates/manifest.js';
import { isTerminalStage, stageForStatus } from '../ticket-templates/stages.js';
import type { TicketFrontmatter } from './types.js';
import type { MoveVerb, FlagVerb } from './verbs.js';

export interface TicketVerbAction {
  command: string;
  label: string;
  description: string;
  targetStatus: string;
  disabled: boolean;
  disabledReason: string | null;
  warning: string | null;
  requiresReason: boolean;
}

const VERB_LABELS: Record<string, string> = {
  plan: 'Plan',
  approve: 'Approve plan',
  start: 'Start',
  review: 'Send to review',
  done: 'Done',
  drop: 'Drop',
  reopen: 'Reopen',
  block: 'Block',
  unblock: 'Unblock',
  park: 'Park',
  unpark: 'Unpark',
};

const VERB_DESCRIPTIONS: Record<string, string> = {
  plan: 'Move into planning (or create plan file).',
  approve: 'Approve the plan and move to ready.',
  start: 'Begin implementation.',
  review: 'Move to review.',
  done: 'Mark done.',
  drop: 'Drop the ticket (requires a reason).',
  reopen: 'Reopen from done or dropped.',
  block: 'Block without changing stage (requires a reason).',
  unblock: 'Clear the blocked flag.',
  park: 'Park without changing stage (requires a reason).',
  unpark: 'Clear the parked flag.',
};

const MOVE_TARGET: Record<Exclude<MoveVerb, 'reopen'>, StageId | 'dropped'> = {
  plan: 'planning',
  approve: 'ready',
  start: 'in_progress',
  review: 'review',
  done: 'done',
  drop: 'dropped',
};

function manifestHasStage(manifest: TemplateManifest, stage: StageId): boolean {
  return manifest.stages.some((s) => s.id === stage);
}

function previousStageInSubset(manifest: TemplateManifest, target: StageId): StageId | null {
  const subset = manifest.stages.map((s) => s.id);
  const idx = subset.indexOf(target);
  if (idx <= 0) return null;
  return subset[idx - 1] ?? null;
}

function isFileOnlyVerb(manifest: TemplateManifest, verb: 'plan' | 'approve'): boolean {
  if (!hasPlanRole(manifest)) return false;
  if (verb === 'plan') return !manifestHasStage(manifest, 'planning');
  return !manifestHasStage(manifest, 'planning') && !manifestHasStage(manifest, 'ready');
}

function stageBeforeDone(manifest: TemplateManifest): StageId {
  const subset = manifest.stages.map((s) => s.id);
  const doneIdx = subset.indexOf('done');
  if (doneIdx <= 0) return subset[subset.length - 1] ?? 'backlog';
  return subset[doneIdx - 1];
}

function requiresReason(verb: string): boolean {
  return verb === 'block' || verb === 'park' || verb === 'drop';
}

function makeAction(
  verb: string,
  targetStatus: string,
  overrides?: Partial<TicketVerbAction>,
): TicketVerbAction {
  return {
    command: verb,
    label: VERB_LABELS[verb] ?? verb,
    description: VERB_DESCRIPTIONS[verb] ?? `Run ${verb}`,
    targetStatus,
    disabled: false,
    disabledReason: null,
    warning: null,
    requiresReason: requiresReason(verb),
    ...overrides,
  };
}

async function gateDisabledReason(
  verb: VerbWithGates | 'approve',
  ticketDir: string,
): Promise<string | null> {
  const ctx = await buildGateContext(ticketDir);
  const results = await evaluateVerbGates(verb as VerbWithGates, ctx);
  const failing = firstFailingGate(results);
  if (!failing) return null;
  return failing.reason ?? 'Gate check failed';
}

async function moveVerbAction(
  verb: MoveVerb,
  fm: TicketFrontmatter,
  manifest: TemplateManifest,
  ticketDir: string,
): Promise<TicketVerbAction | null> {
  const current = stageForStatus(fm.status);

  if (verb === 'drop') {
    if (isTerminalStage(current)) return null;
    return makeAction('drop', 'dropped');
  }

  if (verb === 'reopen') {
    if (current !== 'done' && current !== 'dropped') return null;
    const target = stageBeforeDone(manifest);
    return makeAction('reopen', target);
  }

  if ((verb === 'plan' || verb === 'approve') && !hasPlanRole(manifest)) return null;

  const target = MOVE_TARGET[verb as Exclude<MoveVerb, 'reopen'>];
  const fileOnly = (verb === 'plan' || verb === 'approve') && isFileOnlyVerb(manifest, verb);

  if (!fileOnly && !manifestHasStage(manifest, target as StageId)) return null;

  const requiredFrom = fileOnly ? null : previousStageInSubset(manifest, target as StageId);
  if (requiredFrom !== null && current !== requiredFrom) return null;

  const toStatus = fileOnly ? current : (target as string);
  const action = makeAction(verb, toStatus);

  if (verb === 'start' && !fm.assignee) {
    action.warning = 'No assignee set — consider assigning before starting.';
  }

  if (!fileOnly && (verb === 'plan' || verb === 'approve' || verb === 'start' || verb === 'review' || verb === 'done')) {
    const gateVerb = verb === 'approve' ? 'approve' : verb;
    const reason = await gateDisabledReason(gateVerb as VerbWithGates, ticketDir);
    if (reason) {
      action.disabled = true;
      action.disabledReason = reason;
    }
  }

  return action;
}

function flagVerbAction(verb: FlagVerb, fm: TicketFrontmatter): TicketVerbAction | null {
  if (verb === 'block') {
    if (fm.blocked) return null;
    return makeAction('block', fm.status);
  }
  if (verb === 'unblock') {
    if (!fm.blocked) return null;
    return makeAction('unblock', fm.status);
  }
  if (verb === 'park') {
    if (fm.parked) return null;
    return makeAction('park', fm.status);
  }
  if (verb === 'unpark') {
    if (!fm.parked) return null;
    return makeAction('unpark', fm.status);
  }
  return null;
}

/** List verbs the ticket can run from its current stage and flags. */
export async function getAvailableVerbs(
  ticketDir: string,
  fm: TicketFrontmatter,
  manifest: TemplateManifest,
): Promise<TicketVerbAction[]> {
  const moveVerbs: MoveVerb[] = ['plan', 'approve', 'start', 'review', 'done', 'drop', 'reopen'];
  const actions: TicketVerbAction[] = [];

  for (const verb of moveVerbs) {
    const action = await moveVerbAction(verb, fm, manifest, ticketDir);
    if (action) actions.push(action);
  }

  for (const verb of ['block', 'unblock', 'park', 'unpark'] as FlagVerb[]) {
    const action = flagVerbAction(verb, fm);
    if (action) actions.push(action);
  }

  return actions;
}
