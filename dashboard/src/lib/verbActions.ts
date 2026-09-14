import type { TicketTransitionAction } from '../hooks/useProjects';

const TEMPLATE_STAGES: Record<string, readonly string[]> = {
  feature: ['backlog', 'planning', 'ready', 'in_progress', 'review', 'done'],
  legacy: ['backlog', 'planning', 'ready', 'in_progress', 'review', 'done'],
  bug: ['backlog', 'in_progress', 'review', 'done'],
  spike: ['backlog', 'in_progress', 'done'],
  quick: ['backlog', 'done'],
};

const TEMPLATES_WITH_PLAN = new Set(['feature', 'legacy', 'bug']);
const TERMINAL_STAGES = new Set(['done', 'dropped']);
const SECONDARY_COMMANDS = ['drop', 'reopen', 'block', 'unblock', 'park', 'unpark'] as const;

const MOVE_TARGETS: Record<string, string> = {
  plan: 'planning',
  approve: 'ready',
  start: 'in_progress',
  review: 'review',
  done: 'done',
  drop: 'dropped',
};

function stagesForTemplate(templateId: string | null): readonly string[] {
  return TEMPLATE_STAGES[templateId ?? 'feature'] ?? TEMPLATE_STAGES.feature;
}

function hasPlanRole(templateId: string | null): boolean {
  return TEMPLATES_WITH_PLAN.has(templateId ?? 'feature');
}

function previousStage(stages: readonly string[], target: string): string | null {
  const idx = stages.indexOf(target);
  if (idx <= 0) return null;
  return stages[idx - 1] ?? null;
}

function stageBeforeDone(stages: readonly string[]): string {
  const doneIdx = stages.indexOf('done');
  if (doneIdx <= 0) return stages[stages.length - 1] ?? 'backlog';
  return stages[doneIdx - 1];
}

/** Parse the verb name from a `show` Next line (`syntaur plan create ID`, `syntaur start ID`, …). */
export function verbFromNextLine(next: string | null): string | null {
  if (!next) return null;
  if (/plan create/i.test(next)) return 'plan';
  const match = next.match(/syntaur\s+(\w+)\s+/i);
  return match?.[1] ?? null;
}

function offersMoveVerb(
  verb: string,
  stage: string,
  templateId: string | null,
): boolean {
  const stages = stagesForTemplate(templateId);
  if (verb === 'drop') return !TERMINAL_STAGES.has(stage);
  if (verb === 'reopen') return stage === 'done' || stage === 'dropped';
  if ((verb === 'plan' || verb === 'approve') && !hasPlanRole(templateId)) return false;

  const target = MOVE_TARGETS[verb];
  if (!target) return false;

  if (verb === 'plan' && !stages.includes('planning')) {
    return hasPlanRole(templateId);
  }
  if (verb === 'approve' && !stages.includes('ready') && !stages.includes('planning')) {
    return hasPlanRole(templateId);
  }
  if (verb !== 'plan' && verb !== 'approve' && !stages.includes(target)) return false;

  const requiredFrom =
    verb === 'plan' && !stages.includes('planning')
      ? null
      : verb === 'approve' && !stages.includes('planning') && !stages.includes('ready')
        ? null
        : previousStage(stages, target);
  if (requiredFrom !== null && stage !== requiredFrom) return false;
  if (verb === 'reopen') return TERMINAL_STAGES.has(stage);
  return true;
}

function offersFlagVerb(
  verb: string,
  stage: string,
  blocked: string | null,
  parked: string | null,
): boolean {
  if (TERMINAL_STAGES.has(stage) && (verb === 'block' || verb === 'park')) return false;
  if (verb === 'block') return !blocked;
  if (verb === 'unblock') return Boolean(blocked);
  if (verb === 'park') return !parked;
  if (verb === 'unpark') return Boolean(parked);
  return false;
}

/** Pure verb-offer matrix for dashboard controls (no gate evaluation). */
export function offeredVerbCommands(
  templateId: string | null,
  stage: string,
  flags: { blocked: string | null; parked: string | null },
): string[] {
  const moveVerbs = ['plan', 'approve', 'start', 'review', 'done', 'drop', 'reopen'];
  const offered: string[] = [];
  for (const verb of moveVerbs) {
    if (offersMoveVerb(verb, stage, templateId)) offered.push(verb);
  }
  for (const verb of SECONDARY_COMMANDS) {
    if (offersFlagVerb(verb, stage, flags.blocked, flags.parked)) offered.push(verb);
  }
  return offered;
}

export function pickPrimaryVerb(
  next: string | null,
  availableVerbs: TicketTransitionAction[],
): TicketTransitionAction | null {
  const hinted = verbFromNextLine(next);
  const enabled = availableVerbs.filter((a) => !a.disabled && a.targetStatus);
  if (hinted) {
    const match = enabled.find((a) => a.command === hinted);
    if (match) return match;
  }
  const forward = ['plan', 'approve', 'start', 'review', 'done'];
  for (const cmd of forward) {
    const match = enabled.find((a) => a.command === cmd);
    if (match && match.targetStatus !== match.command) return match;
  }
  return enabled[0] ?? null;
}

export function pickSecondaryVerbs(
  availableVerbs: TicketTransitionAction[],
  primary: TicketTransitionAction | null,
): TicketTransitionAction[] {
  return availableVerbs.filter(
    (a) =>
      SECONDARY_COMMANDS.includes(a.command as (typeof SECONDARY_COMMANDS)[number]) &&
      a !== primary &&
      !a.disabled,
  );
}

export function stageBeforeDoneForTemplate(templateId: string | null): string {
  return stageBeforeDone(stagesForTemplate(templateId));
}
