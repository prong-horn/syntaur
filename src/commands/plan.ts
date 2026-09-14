import { Command } from 'commander';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileExists, writeFileForce } from '../utils/fs.js';
import { recomputeTicketDir } from '../lifecycle/recompute.js';
import { updatePlanBlock } from '../lifecycle/frontmatter.js';
import { resolveSessionEngagement } from '../utils/engagement-binding.js';
import { resolveTicketTarget } from '../utils/ticket-target.js';
import { assertMayMutate } from '../utils/session-id.js';

async function resolveTicketDir(opts: {
  ticket?: string;
  project?: string;
  cwd?: string;
}): Promise<string> {
  const cwd = opts.cwd ?? process.cwd();
  if (opts.ticket) {
    const target = await resolveTicketTarget(opts.ticket, {
      project: opts.project,
      cwd,
    });
    return target.ticketDir;
  }
  // No explicit target → resolve from the session's OPEN engagement and gate
  // the mutation. context.json's ticket scalar is no longer a resolution
  // source (it is a workspace marker only).
  const { initSessionDb } = await import('../dashboard/session-db.js');
  initSessionDb(); // idempotent; no-op if already open
  const se = await resolveSessionEngagement(cwd);
  if (se) {
    assertMayMutate(se.session, { hasSelector: false });
  }
  const target = await resolveTicketTarget(undefined, {
    project: opts.project,
    cwd,
    resolveEngagement: async () => se?.open ?? null,
  });
  return target.ticketDir;
}

const PLAN_PATTERN = /^plan(?:-v(\d+))?\.md$/;

interface PlanFileEntry {
  fileName: string;
  version: number; // plan.md = 1
}

async function listPlanFiles(ticketDir: string): Promise<PlanFileEntry[]> {
  if (!(await fileExists(ticketDir))) return [];
  const entries = await readdir(ticketDir, { withFileTypes: true });
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
  ticketSlug: string;
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
ticket: ${opts.ticketSlug}
status: draft
created: "${created}"
updated: "${created}"
---

# ${opts.ticketSlug} — Implementation Plan v${opts.newVersion}

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

function buildInitialPlanStub(ticketSlug: string): string {
  const created = isoNow();
  return `---
ticket: ${ticketSlug}
status: draft
created: "${created}"
updated: "${created}"
---

# ${ticketSlug} — Implementation Plan

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
  ticket?: string;
  project?: string;
  force?: boolean;
}

async function runPlanCreate(options: PlanCreateOptions): Promise<void> {
  const ticketDir = await resolveTicketDir(options);
  if (!(await fileExists(ticketDir))) {
    throw new Error(`Ticket directory does not exist: ${ticketDir}`);
  }
  const ticketMdPath = resolve(ticketDir, 'ticket.md');
  if (!(await fileExists(ticketMdPath))) {
    throw new Error(`Missing ticket.md at: ${ticketMdPath}`);
  }

  const planPath = resolve(ticketDir, 'plan.md');
  if ((await fileExists(planPath)) && !options.force) {
    throw new Error(
      'plan.md already exists. Use --force to overwrite, or `syntaur plan version` to create the next version.',
    );
  }

  const ticketMd = await readFile(ticketMdPath, 'utf-8');
  const slugMatch = ticketMd.match(/^slug:\s*(.+?)\s*$/m);
  const slug = slugMatch ? slugMatch[1].trim() : ticketDir.split('/').pop() ?? '';

  await writeFileForce(planPath, buildInitialPlanStub(slug));

  console.log(`Created ${planPath}`);

  // Keep derived status current: writing a plan flips planExists (and a new
  // plan can invalidate a stale approval). Explicit verb → recompute regardless
  // of the migration gate; best-effort, never blocks the create.
  await recomputeTicketDir(ticketDir, 'plan-create', null);
}

interface PlanVersionOptions {
  ticket?: string;
  project?: string;
  force?: boolean;
}

async function runPlanVersion(options: PlanVersionOptions): Promise<void> {
  const ticketDir = await resolveTicketDir(options);
  if (!(await fileExists(ticketDir))) {
    throw new Error(`Ticket directory does not exist: ${ticketDir}`);
  }

  const ticketMdPath = resolve(ticketDir, 'ticket.md');
  if (!(await fileExists(ticketMdPath))) {
    throw new Error(`Missing ticket.md at: ${ticketMdPath}`);
  }

  const planFiles = await listPlanFiles(ticketDir);
  if (planFiles.length === 0) {
    throw new Error(
      `No plan.md (or plan-v<N>.md) found in ${ticketDir}. Run /plan-ticket to create plan.md first.`,
    );
  }

  const current = planFiles[planFiles.length - 1];
  const next = nextPlanFileName(current.version);
  const newPath = resolve(ticketDir, next.fileName);

  if ((await fileExists(newPath)) && !options.force) {
    throw new Error(`${next.fileName} already exists. Use --force to overwrite.`);
  }

  // Parse the ticket slug from frontmatter (kebab from path as fallback).
  const ticketMd = await readFile(ticketMdPath, 'utf-8');
  const slugMatch = ticketMd.match(/^slug:\s*(.+?)\s*$/m);
  const slug = slugMatch ? slugMatch[1].trim() : ticketDir.split('/').pop() ?? '';

  // Read prior plan body to scrape unchecked todos.
  const oldPlanPath = resolve(ticketDir, current.fileName);
  const oldPlanContent = await readFile(oldPlanPath, 'utf-8');
  const oldBody = oldPlanContent.replace(/^---[\s\S]*?\n---\n?/, '');
  const carriedTodos = extractUncheckedTodos(oldBody);

  // Build the new plan stub.
  const stub = buildNewPlanStub({
    ticketSlug: slug,
    newVersion: next.version,
    oldVersion: current.version,
    uncheckedTodos: carriedTodos,
  });

  await writeFileForce(newPath, stub);

  console.log(`Created ${next.fileName} (superseding ${current.fileName}).`);
  console.log(`Path: ${newPath}`);
  console.log(`Carried forward: ${carriedTodos.length} unchecked task(s).`);

  // A new plan version moves plan.file to the new revision and clears any
  // prior approval so planApproved drops immediately (revision-bound).
  const ticketContent = await readFile(ticketMdPath, 'utf-8');
  await writeFileForce(
    ticketMdPath,
    updatePlanBlock(ticketContent, {
      file: next.fileName,
      approvedDigest: null,
      approvedAt: null,
      approvedBy: null,
    }),
  );

  // Recompute so the derived status reflects the invalidated approval.
  // Explicit verb → runs regardless of the migration gate.
  await recomputeTicketDir(ticketDir, 'plan-version', null);
}

export const planCommand = new Command('plan')
  .description('Manage plan files for the active ticket');

planCommand
  .command('create')
  .description('Create the initial plan.md for the ticket')
  .option('--ticket <id>', "Ticket id. Defaults to the session's open engagement")
  .option('--project <slug>', 'Project slug. Required when --ticket is given for a project-nested ticket')
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
  .option('--ticket <id>', "Ticket id. Defaults to the session's open engagement")
  .option('--project <slug>', 'Project slug. Required when --ticket is given for a project-nested ticket')
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
  resolveTicketDir,
  runPlanVersion,
  runPlanCreate,
  buildInitialPlanStub,
};

// ── plan approval (derived-status v3: revision-bound file + digest) ─────────
import { planApproveCommand, planUnapproveCommand } from './derive-verbs.js';

planCommand
  .command('approve')
  .description('Approve the latest plan revision (file+digest bound); ready_to_implement derives from it')
  .argument('<ticket>', 'Ticket slug or standalone UUID')
  .option('--project <slug>', 'Target project slug')
  .option('--agent <name>', 'Acting agent id (default: bound session, else human)')
  .option('--dir <path>', 'Override default project directory')
  .action(async (ticket, options) => {
    try {
      await planApproveCommand(ticket, options);
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

planCommand
  .command('unapprove')
  .description('Clear plan approval; the phase regresses to planning-level facts')
  .argument('<ticket>', 'Ticket slug or standalone UUID')
  .option('--project <slug>', 'Target project slug')
  .option('--agent <name>', 'Acting agent id')
  .option('--dir <path>', 'Override default project directory')
  .action(async (ticket, options) => {
    try {
      await planUnapproveCommand(ticket, options);
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });
