import { Command } from 'commander';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileExists, writeFileForce } from '../utils/fs.js';
import { assignmentsDir } from '../utils/paths.js';
import { readConfig } from '../utils/config.js';
import { recomputeAssignmentDir } from '../lifecycle/recompute.js';
import { resolveSessionEngagement } from '../utils/engagement-binding.js';
import { resolveAssignmentTarget } from '../utils/assignment-target.js';
import { assertMayMutate } from '../utils/session-id.js';

async function resolveAssignmentDir(opts: {
  assignment?: string;
  project?: string;
  cwd?: string;
}): Promise<string> {
  const cwd = opts.cwd ?? process.cwd();
  if (opts.assignment) {
    if (opts.project) {
      return resolve((await readConfig()).defaultProjectDir, opts.project, 'assignments', opts.assignment);
    }
    // Standalone (assignment is UUID under ~/.syntaur/assignments/)
    return resolve(assignmentsDir(), opts.assignment);
  }
  // No explicit target → resolve from the session's OPEN engagement and gate
  // the mutation. context.json's assignment scalar is no longer a resolution
  // source (it is a workspace marker only).
  const { initSessionDb } = await import('../dashboard/session-db.js');
  initSessionDb(); // idempotent; no-op if already open
  const se = await resolveSessionEngagement(cwd);
  if (se) {
    assertMayMutate(se.session, { hasSelector: false });
  }
  const target = await resolveAssignmentTarget(undefined, {
    project: opts.project,
    cwd,
    resolveEngagement: async () => se?.open ?? null,
  });
  return target.assignmentDir;
}

const PLAN_PATTERN = /^plan(?:-v(\d+))?\.md$/;

interface PlanFileEntry {
  fileName: string;
  version: number; // plan.md = 1
}

async function listPlanFiles(assignmentDir: string): Promise<PlanFileEntry[]> {
  if (!(await fileExists(assignmentDir))) return [];
  const entries = await readdir(assignmentDir, { withFileTypes: true });
  const out: PlanFileEntry[] = [];
  for (const e of entries) {
    if (!e.isFile()) continue;
    const m = e.name.match(PLAN_PATTERN);
    if (!m) continue;
    const version = m[1] ? parseInt(m[1], 10) : 1;
    out.push({ fileName: e.name, version });
  }
  out.sort((a, b) => a.version - b.version);
  return out;
}

function nextPlanFileName(currentVersion: number): { fileName: string; version: number } {
  const next = currentVersion + 1;
  return { fileName: `plan-v${next}.md`, version: next };
}

function planLabel(version: number): string {
  return version === 1 ? 'plan' : `plan v${version}`;
}

function planLinkText(version: number): string {
  return version === 1 ? 'plan' : `plan v${version}`;
}

function planFileName(version: number): string {
  return version === 1 ? 'plan.md' : `plan-v${version}.md`;
}

/**
 * Extract any `- [ ] ...` lines from the prior plan's body (anywhere). These
 * are the "unchecked todos" the new plan should carry forward.
 */
function extractUncheckedTodos(planBody: string): string[] {
  const out: string[] = [];
  for (const line of planBody.split('\n')) {
    if (/^\s*-\s*\[\s\]\s+/.test(line)) {
      out.push(line);
    }
  }
  return out;
}

function isoNow(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function buildNewPlanStub(opts: {
  assignmentSlug: string;
  newVersion: number;
  oldVersion: number;
  uncheckedTodos: string[];
}): string {
  const created = isoNow();
  const oldLabel = planLabel(opts.oldVersion);
  const carriedSection =
    opts.uncheckedTodos.length === 0
      ? '_No unchecked tasks carried forward from the prior plan._'
      : opts.uncheckedTodos.join('\n');

  return `---
assignment: ${opts.assignmentSlug}
status: draft
created: "${created}"
updated: "${created}"
---

# ${opts.assignmentSlug} — Implementation Plan v${opts.newVersion}

**Date:** ${created.slice(0, 10)}
**Supersedes:** [${oldLabel}](./${planFileName(opts.oldVersion)})

## Objective

<!-- Describe what changed and why a new plan is needed. -->

## Carried-forward tasks

${carriedSection}

## Tasks

<!-- Add the new plan tasks here. -->

## Verification

<!-- Add verification steps here. -->
`;
}

function buildInitialPlanStub(assignmentSlug: string): string {
  const created = isoNow();
  return `---
assignment: ${assignmentSlug}
status: draft
created: "${created}"
updated: "${created}"
---

# ${assignmentSlug} — Implementation Plan

**Date:** ${created.slice(0, 10)}

## Objective

<!-- Describe the goal and success criteria. -->

## Tasks

<!-- Add the implementation tasks here. -->

## Verification

<!-- Add verification steps here. -->
`;
}

interface PlanCreateOptions {
  assignment?: string;
  project?: string;
  force?: boolean;
}

async function runPlanCreate(options: PlanCreateOptions): Promise<void> {
  const assignmentDir = await resolveAssignmentDir(options);
  if (!(await fileExists(assignmentDir))) {
    throw new Error(`Assignment directory does not exist: ${assignmentDir}`);
  }
  const assignmentMdPath = resolve(assignmentDir, 'assignment.md');
  if (!(await fileExists(assignmentMdPath))) {
    throw new Error(`Missing assignment.md at: ${assignmentMdPath}`);
  }

  const planPath = resolve(assignmentDir, 'plan.md');
  if ((await fileExists(planPath)) && !options.force) {
    throw new Error(
      'plan.md already exists. Use --force to overwrite, or `syntaur plan version` to create the next version.',
    );
  }

  const assignmentMd = await readFile(assignmentMdPath, 'utf-8');
  const slugMatch = assignmentMd.match(/^slug:\s*(.+?)\s*$/m);
  const slug = slugMatch ? slugMatch[1].trim() : assignmentDir.split('/').pop() ?? '';

  await writeFileForce(planPath, buildInitialPlanStub(slug));

  console.log(`Created ${planPath}`);

  // Keep derived status current: writing a plan flips planExists (and a new
  // plan can invalidate a stale approval). Explicit verb → recompute regardless
  // of the migration gate; best-effort, never blocks the create.
  await recomputeAssignmentDir(assignmentDir, 'plan-create', null);
}

interface PlanVersionOptions {
  assignment?: string;
  project?: string;
  force?: boolean;
}

async function runPlanVersion(options: PlanVersionOptions): Promise<void> {
  const assignmentDir = await resolveAssignmentDir(options);
  if (!(await fileExists(assignmentDir))) {
    throw new Error(`Assignment directory does not exist: ${assignmentDir}`);
  }

  const assignmentMdPath = resolve(assignmentDir, 'assignment.md');
  if (!(await fileExists(assignmentMdPath))) {
    throw new Error(`Missing assignment.md at: ${assignmentMdPath}`);
  }

  const planFiles = await listPlanFiles(assignmentDir);
  if (planFiles.length === 0) {
    throw new Error(
      `No plan.md (or plan-v<N>.md) found in ${assignmentDir}. Run /plan-assignment to create plan.md first.`,
    );
  }

  const current = planFiles[planFiles.length - 1];
  const next = nextPlanFileName(current.version);
  const newPath = resolve(assignmentDir, next.fileName);

  if ((await fileExists(newPath)) && !options.force) {
    throw new Error(`${next.fileName} already exists. Use --force to overwrite.`);
  }

  // Parse the assignment slug from frontmatter (kebab from path as fallback).
  const assignmentMd = await readFile(assignmentMdPath, 'utf-8');
  const slugMatch = assignmentMd.match(/^slug:\s*(.+?)\s*$/m);
  const slug = slugMatch ? slugMatch[1].trim() : assignmentDir.split('/').pop() ?? '';

  // Read prior plan body to scrape unchecked todos.
  const oldPlanPath = resolve(assignmentDir, current.fileName);
  const oldPlanContent = await readFile(oldPlanPath, 'utf-8');
  const oldBody = oldPlanContent.replace(/^---[\s\S]*?\n---\n?/, '');
  const carriedTodos = extractUncheckedTodos(oldBody);

  // Build the new plan stub.
  const stub = buildNewPlanStub({
    assignmentSlug: slug,
    newVersion: next.version,
    oldVersion: current.version,
    uncheckedTodos: carriedTodos,
  });

  await writeFileForce(newPath, stub);

  console.log(`Created ${next.fileName} (superseding ${current.fileName}).`);
  console.log(`Path: ${newPath}`);
  console.log(`Carried forward: ${carriedTodos.length} unchecked task(s).`);

  // A new plan version invalidates any prior plan approval (digest no longer
  // matches the latest plan file). Recompute so the derived status reflects
  // that immediately. Explicit verb → runs regardless of the migration gate.
  await recomputeAssignmentDir(assignmentDir, 'plan-version', null);
}

export const planCommand = new Command('plan')
  .description('Manage plan files for the active assignment');

planCommand
  .command('create')
  .description('Create the initial plan.md for the assignment')
  .option('--assignment <slug>', "Assignment slug (UUID for standalone). Defaults to the session's open engagement")
  .option('--project <slug>', 'Project slug. Required when --assignment is given for a project-nested assignment')
  .option('--force', 'Overwrite an existing plan.md')
  .action(async (options: PlanCreateOptions) => {
    try {
      await runPlanCreate(options);
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

planCommand
  .command('version')
  .description(
    'Create the next plan-v<N>.md and carry forward unchecked tasks from the prior plan',
  )
  .option('--assignment <slug>', "Assignment slug (UUID for standalone). Defaults to the session's open engagement")
  .option('--project <slug>', 'Project slug. Required when --assignment is given for a project-nested assignment')
  .option('--force', 'Overwrite if the next plan-v<N>.md already exists')
  .action(async (options: PlanVersionOptions) => {
    try {
      await runPlanVersion(options);
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

// Exported for tests
export const _internal = {
  extractUncheckedTodos,
  nextPlanFileName,
  listPlanFiles,
  resolveAssignmentDir,
  runPlanVersion,
  runPlanCreate,
  buildInitialPlanStub,
};

// ── plan approval (derived-status v3: revision-bound file + digest) ─────────
import { planApproveCommand, planUnapproveCommand } from './derive-verbs.js';

planCommand
  .command('approve')
  .description('Approve the latest plan revision (file+digest bound); ready_to_implement derives from it')
  .argument('<assignment>', 'Assignment slug or standalone UUID')
  .option('--project <slug>', 'Target project slug')
  .option('--agent <name>', 'Acting agent id (default: bound session, else human)')
  .option('--dir <path>', 'Override default project directory')
  .action(async (assignment, options) => {
    try {
      await planApproveCommand(assignment, options);
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

planCommand
  .command('unapprove')
  .description('Clear plan approval; the phase regresses to planning-level facts')
  .argument('<assignment>', 'Assignment slug or standalone UUID')
  .option('--project <slug>', 'Target project slug')
  .option('--agent <name>', 'Acting agent id')
  .option('--dir <path>', 'Override default project directory')
  .action(async (assignment, options) => {
    try {
      await planUnapproveCommand(assignment, options);
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });
