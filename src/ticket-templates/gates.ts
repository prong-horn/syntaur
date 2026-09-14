import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { GateId, StageId, TemplateManifest, VerbWithGates } from './manifest.js';
import { deliverableRoleFile, logRoleFile, planRoleFile } from './manifest.js';
import type { TicketFrontmatter } from '../lifecycle/types.js';
import { countRealAcceptanceCriteria, isPlanApproved } from '../lifecycle/facts.js';
import { fileExists } from '../utils/fs.js';
import { nonEmptyBeyondScaffold } from './content.js';
import type { LogEntry } from './log-reader.js';
import { planFileFor } from './roles.js';
import { stageForStatus, stageIndex } from './stages.js';

export interface GateResult {
  pass: boolean;
  reason?: string;
  hint: string;
}

export const GATE_HINTS: Record<GateId, string> = {
  'plan-exists': 'Run syntaur plan create',
  'plan-approved': 'Run syntaur approve',
  'deps-done': 'Wait for dependencies',
  'workspace-set': 'Set workspace in ticket.md',
  'criteria-checked': 'Tick acceptance criteria',
  'handoff-logged': 'Log a handoff entry',
  'review-clean': 'Log an approving review',
  'deliverable-present': 'Write deliverable',
};

const VERB_FOR_STAGE: Partial<Record<StageId, VerbWithGates>> = {
  planning: 'plan',
  ready: 'approve',
  in_progress: 'start',
  review: 'review',
  done: 'done',
};

export interface GateContext {
  ticketDir: string;
  fm: TicketFrontmatter;
  manifest: TemplateManifest;
  ticketBody: string;
  logEntries: LogEntry[];
  dependencyStages: Map<string, StageId | 'dropped'>;
}

function workspaceSet(fm: TicketFrontmatter): boolean {
  const w = fm.workspace;
  return Boolean(
    w.repository?.trim() &&
      w.branch?.trim() &&
      w.worktreePath?.trim() &&
      w.parentBranch?.trim(),
  );
}

function dependencyDone(stage: StageId | 'dropped'): boolean {
  return stage === 'done';
}

function reviewEntryClean(entry: LogEntry): boolean {
  if (entry.type !== 'review') return false;
  const verdictLine =
    entry.keys.verdict ??
    entry.body.split('\n').find((l) => l.trim().startsWith('verdict:')) ??
    '';
  if (!verdictLine) return false;
  const approve =
    /^approve\b/i.test(verdictLine.trim()) || /verdict:\s*approve\b/i.test(verdictLine);
  const highZero = /high\s*=\s*0\b/i.test(verdictLine);
  return approve && highZero;
}

export async function evaluateGate(gateId: GateId, ctx: GateContext): Promise<GateResult> {
  const hint = GATE_HINTS[gateId];

  switch (gateId) {
    case 'plan-exists': {
      const planPath = planFileFor(ctx.fm, ctx.manifest);
      if (!planPath) {
        return { pass: false, reason: 'no plan role', hint };
      }
      const full = resolve(ctx.ticketDir, planPath);
      if (!(await fileExists(full))) {
        return { pass: false, reason: 'plan file missing', hint };
      }
      const content = await readFile(full, 'utf-8');
      if (!nonEmptyBeyondScaffold(content)) {
        return { pass: false, reason: 'plan file is empty', hint };
      }
      return { pass: true, hint };
    }
    case 'plan-approved': {
      const approved = await isPlanApproved(ctx.ticketDir, ctx.fm);
      if (!approved) {
        return { pass: false, reason: 'plan is not approved', hint };
      }
      return { pass: true, hint };
    }
    case 'deps-done': {
      for (const dep of ctx.fm.depends_on) {
        const stage = ctx.dependencyStages.get(dep);
        if (!stage || !dependencyDone(stage)) {
          return { pass: false, reason: `dependency ${dep} is not done`, hint };
        }
      }
      return { pass: true, hint };
    }
    case 'workspace-set': {
      if (ctx.manifest.workspace !== 'required') {
        return { pass: true, hint };
      }
      if (!workspaceSet(ctx.fm)) {
        return { pass: false, reason: 'workspace fields are incomplete', hint };
      }
      return { pass: true, hint };
    }
    case 'criteria-checked': {
      const { total, checked } = countRealAcceptanceCriteria(ctx.ticketBody);
      if (total > 0 && checked < total) {
        return {
          pass: false,
          reason: `${checked} of ${total} acceptance criteria checked`,
          hint,
        };
      }
      return { pass: true, hint };
    }
    case 'handoff-logged': {
      const hasHandoff = ctx.logEntries.some((e) => e.type === 'handoff');
      if (!hasHandoff) {
        return { pass: false, reason: 'no handoff entry logged', hint };
      }
      return { pass: true, hint };
    }
    case 'review-clean': {
      const latestReview = ctx.logEntries.find((e) => e.type === 'review');
      if (!latestReview || !reviewEntryClean(latestReview)) {
        return { pass: false, reason: 'latest review is not a clean approve', hint };
      }
      return { pass: true, hint };
    }
    case 'deliverable-present': {
      const role = deliverableRoleFile(ctx.manifest);
      if (!role) {
        return { pass: true, hint };
      }
      const full = resolve(ctx.ticketDir, role.path);
      if (!(await fileExists(full))) {
        return { pass: false, reason: 'deliverable file missing', hint };
      }
      const content = await readFile(full, 'utf-8');
      if (!nonEmptyBeyondScaffold(content)) {
        return { pass: false, reason: 'deliverable file is empty', hint };
      }
      return { pass: true, hint };
    }
    default:
      return { pass: false, reason: `unknown gate ${gateId}`, hint };
  }
}

export function gatesForVerb(
  manifest: TemplateManifest,
  verb: VerbWithGates,
): GateId[] {
  return manifest.gates[verb] ?? [];
}

export async function evaluateVerbGates(
  verb: VerbWithGates,
  ctx: GateContext,
): Promise<GateResult[]> {
  const ids = gatesForVerb(ctx.manifest, verb);
  const results: GateResult[] = [];
  for (const id of ids) {
    results.push(await evaluateGate(id, ctx));
  }
  return results;
}

export function firstFailingGate(results: GateResult[]): GateResult | null {
  return results.find((r) => !r.pass) ?? null;
}

/** Next stage in the template subset after `current`, or null at terminal. */
export function nextTemplateStage(
  manifest: TemplateManifest,
  current: StageId | 'dropped',
): StageId | null {
  if (current === 'done' || current === 'dropped') return null;
  const subset = manifest.stages.map((s) => s.id);
  const currentIdx = stageIndex(current);
  let best: StageId | null = null;
  let bestIdx = Infinity;
  for (const stage of subset) {
    const idx = stageIndex(stage);
    if (idx > currentIdx && idx < bestIdx) {
      best = stage;
      bestIdx = idx;
    }
  }
  return best;
}

/** When the ticket sits on a stage outside the template subset. */
export function nextStageAfterOffTemplate(
  manifest: TemplateManifest,
  current: StageId | 'dropped',
): StageId | null {
  if (current === 'done' || current === 'dropped') return null;
  const currentIdx = stageIndex(current);
  const subset = manifest.stages.map((s) => s.id);
  let best: StageId | null = null;
  let bestIdx = Infinity;
  for (const stage of subset) {
    const idx = stageIndex(stage);
    if (idx > currentIdx && idx < bestIdx) {
      best = stage;
      bestIdx = idx;
    }
  }
  return best;
}

export function stageDeclared(manifest: TemplateManifest, stage: StageId | 'dropped'): boolean {
  if (stage === 'dropped') return false;
  return manifest.stages.some((s) => s.id === stage);
}

export function verbForTargetStage(stage: StageId): VerbWithGates | null {
  return VERB_FOR_STAGE[stage] ?? null;
}

export async function computeNextLine(
  ticketId: string,
  currentStage: StageId | 'dropped',
  manifest: TemplateManifest,
  ctx: GateContext,
): Promise<string> {
  if (currentStage === 'done' || currentStage === 'dropped') {
    return 'none (terminal)';
  }

  const declared = stageDeclared(manifest, currentStage);
  const nextStage = declared
    ? nextTemplateStage(manifest, currentStage)
    : nextStageAfterOffTemplate(manifest, currentStage);

  if (!nextStage) {
    return 'none (terminal)';
  }

  const verb = verbForTargetStage(nextStage);
  if (!verb) {
    return GATE_HINTS['criteria-checked'];
  }

  const results = await evaluateVerbGates(verb, ctx);
  const failing = firstFailingGate(results);
  if (failing) {
    return failing.hint;
  }

  return `syntaur ${verb} ${ticketId}`;
}

/** Whether the template declares a log role file. */
export function hasLogRole(manifest: TemplateManifest): boolean {
  return logRoleFile(manifest) !== undefined;
}

/** Whether the template declares comments.md. */
export function hasCommentsFile(manifest: TemplateManifest): boolean {
  return manifest.files.some((f) => f.path === 'comments.md');
}

/** Whether the template declares a plan role. */
export function hasPlanRole(manifest: TemplateManifest): boolean {
  return planRoleFile(manifest) !== undefined;
}

export function templateStageIds(manifest: TemplateManifest): StageId[] {
  return manifest.stages.map((s) => s.id);
}

export function resolveDependencyStage(status: string): StageId | 'dropped' {
  return stageForStatus(status);
}
