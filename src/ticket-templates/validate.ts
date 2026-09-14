import {
  type TemplateManifest,
  STAGE_IDS,
  GATE_IDS,
  VERBS_WITH_GATES,
  FILE_ROLES,
  FILE_WRITERS,
  WORKSPACE_MODES,
  PRIORITIES,
  LOG_ENTRY_TYPES,
  CREATE_ON_VALUES,
  planRoleFile,
  logRoleFile,
  deliverableRoleFile,
  stageIds,
} from './manifest.js';

export interface TemplateIssue {
  rule: number | string;
  message: string;
}

const KERNEL_PATHS = new Set(['ticket.md', 'chat/']);

function hasGate(manifest: TemplateManifest, gateId: string): boolean {
  for (const gates of Object.values(manifest.gates)) {
    if (gates?.includes(gateId as never)) return true;
  }
  return false;
}

function stageOrderIndex(id: string): number {
  return STAGE_IDS.indexOf(id as (typeof STAGE_IDS)[number]);
}

/**
 * Validate a parsed manifest against rules 1–12 and 14–16, plus extra enum checks.
 */
export function validateTemplate(
  manifest: TemplateManifest,
  dirEntries: string[],
): TemplateIssue[] {
  const issues: TemplateIssue[] = [];

  // Rule 1: id matches directory name
  const dirName = dirEntries.includes('template.md')
    ? manifest.id
    : manifest.id;
  if (!dirEntries.length || !dirEntries.includes('template.md')) {
    // dir name check uses manifest.id vs expected — caller passes dir name separately
  }

  // Rule 2: version is 1
  if (manifest.version !== 1) {
    issues.push({ rule: 2, message: `version must be 1 (got ${manifest.version})` });
  }

  // Rule 3: every stages[].id is in fixed vocabulary
  for (const stage of manifest.stages) {
    if (!(STAGE_IDS as readonly string[]).includes(stage.id)) {
      issues.push({ rule: 3, message: `unknown stage id "${stage.id}"` });
    }
  }

  // Rule 4: stages order matches global stage order
  const ids = stageIds(manifest);
  for (let i = 1; i < ids.length; i++) {
    if (stageOrderIndex(ids[i]) <= stageOrderIndex(ids[i - 1])) {
      issues.push({
        rule: 4,
        message: `stages are not in global order (${ids[i - 1]} before ${ids[i]})`,
      });
      break;
    }
  }

  // Rule 5: if ready in stages, plan role exists
  if (ids.includes('ready') && !planRoleFile(manifest)) {
    issues.push({ rule: 5, message: 'ready stage requires a plan role file' });
  }

  // Rule 6: plan-approved gate requires plan role
  if (hasGate(manifest, 'plan-approved') && !planRoleFile(manifest)) {
    issues.push({ rule: 6, message: 'plan-approved gate requires a plan role file' });
  }

  // Rule 7: review-clean requires review stage
  if (hasGate(manifest, 'review-clean') && !ids.includes('review')) {
    issues.push({ rule: 7, message: 'review-clean gate requires review stage' });
  }

  // Rule 8: deliverable-present requires deliverable role
  if (hasGate(manifest, 'deliverable-present') && !deliverableRoleFile(manifest)) {
    issues.push({ rule: 8, message: 'deliverable-present gate requires a deliverable role file' });
  }

  // Rule 9: log-reading gates require log role
  const logGates = ['handoff-logged', 'review-clean'];
  const needsLog = logGates.some((g) => hasGate(manifest, g));
  if (needsLog && !logRoleFile(manifest)) {
    issues.push({ rule: 9, message: 'log-reading gates require a log role file' });
  }

  // Rule 10: at most one file per plan, log, deliverable
  const roleCounts: Record<string, number> = {};
  for (const f of manifest.files) {
    if (f.role) {
      roleCounts[f.role] = (roleCounts[f.role] ?? 0) + 1;
    }
  }
  for (const role of ['plan', 'log', 'deliverable']) {
    if ((roleCounts[role] ?? 0) > 1) {
      issues.push({ rule: 10, message: `at most one ${role} role file allowed` });
    }
  }

  // Rule 11: every files[].description non-empty
  for (const f of manifest.files) {
    if (!f.description.trim()) {
      issues.push({ rule: 11, message: `files[].description must be non-empty (${f.path})` });
    }
  }

  // Rule 12: log role files have writer: cli
  for (const f of manifest.files) {
    if (f.role === 'log' && f.writer !== 'cli') {
      issues.push({ rule: 12, message: `log role file ${f.path} must have writer: cli` });
    }
  }

  // Rule 14: createOn values
  const declaredStages = new Set(ids);
  for (const f of manifest.files) {
    const co = f.createOn;
    if (
      co !== 'ticket-creation' &&
      co !== 'never' &&
      !declaredStages.has(co as never)
    ) {
      issues.push({
        rule: 14,
        message: `createOn "${co}" on ${f.path} is not ticket-creation, never, or a declared stage`,
      });
    }
  }

  // Rule 15: kernel paths not in files[]
  for (const f of manifest.files) {
    if (KERNEL_PATHS.has(f.path) || f.path.startsWith('chat/')) {
      issues.push({ rule: 15, message: `kernel path ${f.path} must not appear in files[]` });
    }
  }

  // Rule 16: dropped not in stages (also checked above)
  if (ids.includes('dropped' as never)) {
    issues.push({ rule: 16, message: 'dropped must not appear in stages[]' });
  }

  // stages non-empty and containing done
  if (manifest.stages.length === 0) {
    issues.push({ rule: 'stages-empty', message: 'stages must be non-empty' });
  }
  if (!ids.includes('done')) {
    issues.push({ rule: 'stages-done', message: 'stages must include done' });
  }

  // Extra: writer enum
  for (const f of manifest.files) {
    if (!(FILE_WRITERS as readonly string[]).includes(f.writer)) {
      issues.push({ rule: 'writer', message: `invalid writer "${f.writer}" on ${f.path}` });
    }
  }

  // Extra: createOn enum
  for (const f of manifest.files) {
    if (!(CREATE_ON_VALUES as readonly string[]).includes(f.createOn)) {
      issues.push({ rule: 'createOn', message: `invalid createOn "${f.createOn}" on ${f.path}` });
    }
  }

  // Extra: workspace enum
  if (!(WORKSPACE_MODES as readonly string[]).includes(manifest.workspace)) {
    issues.push({ rule: 'workspace', message: `invalid workspace "${manifest.workspace}"` });
  }

  // Extra: defaultPriority enum
  if (!(PRIORITIES as readonly string[]).includes(manifest.defaultPriority)) {
    issues.push({
      rule: 'defaultPriority',
      message: `invalid defaultPriority "${manifest.defaultPriority}"`,
    });
  }

  // Extra: entryTypes on non-log files rejected
  for (const f of manifest.files) {
    if (f.role !== 'log' && f.entryTypes.length !== LOG_ENTRY_TYPES.length) {
      issues.push({
        rule: 'entryTypes',
        message: `entryTypes only allowed on log role files (${f.path})`,
      });
    }
  }

  // Extra: entryTypes enum on log files
  for (const f of manifest.files) {
    if (f.role === 'log') {
      for (const t of f.entryTypes) {
        if (!(LOG_ENTRY_TYPES as readonly string[]).includes(t)) {
          issues.push({ rule: 'entryTypes', message: `invalid entry type "${t}" on ${f.path}` });
        }
      }
    }
  }

  // Extra: role enum
  for (const f of manifest.files) {
    if (f.role && !(FILE_ROLES as readonly string[]).includes(f.role)) {
      issues.push({ rule: 'role', message: `invalid role "${f.role}" on ${f.path}` });
    }
  }

  // Extra: gate map keys and values
  for (const [verb, gateList] of Object.entries(manifest.gates)) {
    if (!(VERBS_WITH_GATES as readonly string[]).includes(verb)) {
      issues.push({ rule: 'gates-verb', message: `unknown gate verb "${verb}"` });
      continue;
    }
    for (const g of gateList ?? []) {
      if (!(GATE_IDS as readonly string[]).includes(g)) {
        issues.push({ rule: 'gates-id', message: `unknown gate id "${g}" on ${verb}` });
      }
    }
    // gates.<verb> target stage must exist, except plan/approve file-only case
    const planRole = planRoleFile(manifest);
    const hasPlanningOrReady = ids.includes('planning') || ids.includes('ready');
    if (verb === 'plan' && planRole && !hasPlanningOrReady) {
      // file-only case — allowed
    } else if (verb === 'approve' && planRole && !hasPlanningOrReady) {
      // file-only case — allowed
    } else {
      const targetStage =
        verb === 'plan'
          ? 'planning'
          : verb === 'approve'
            ? 'ready'
            : verb === 'start'
              ? 'in_progress'
              : verb === 'review'
                ? 'review'
                : verb === 'done'
                  ? 'done'
                  : null;
      if (targetStage && !ids.includes(targetStage as never)) {
        issues.push({
          rule: 'gates-stage',
          message: `gates.${verb} requires stage "${targetStage}" in stages[]`,
        });
      }
    }
  }

  return issues;
}

/** Validate that manifest id matches the directory name (rule 1). */
export function validateTemplateId(manifest: TemplateManifest, dirName: string): TemplateIssue[] {
  if (manifest.id !== dirName) {
    return [{ rule: 1, message: `id "${manifest.id}" does not match directory "${dirName}"` }];
  }
  return [];
}
