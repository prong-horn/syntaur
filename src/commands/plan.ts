import { Command } from 'commander';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileExists, writeFileForce } from '../utils/fs.js';
import {
  updatePlanBlock,
  parseTicketFrontmatter,
  updateTicketFile,
} from '../lifecycle/frontmatter.js';
import { emitPlanVersioned } from '../lifecycle/event-emit.js';
import {
  GateFailedError,
  moveTicket,
  resolveLifecycleActor,
  resolveLifecycleCaller,
} from '../lifecycle/verbs.js';
import { withTicketMutationLock } from '../utils/ticket-mutation-lock.js';
import {
  completeStageEntry,
  completeStageEntryAfterRecordFailure,
  recordStageEntryLocked,
} from '../lifecycle/stage-entry.js';
import { postCliStageDispatch } from '../chat/dispatch-client.js';
import type { StageId } from '../ticket-templates/manifest.js';
import type { TemplateManifest } from '../ticket-templates/manifest.js';
import { resolveSessionEngagement } from '../utils/engagement-binding.js';
import { resolveTicketTarget } from '../utils/ticket-target.js';
import { assertMayMutate } from '../utils/session-id.js';
import { syntaurRoot } from '../utils/paths.js';
import {
  loadTemplate,
  resolveTemplateForTicket,
  resolveTemplateContentDir,
} from '../ticket-templates/registry.js';
import { planRoleFile } from '../ticket-templates/manifest.js';
import {
  planRevisions,
  planStemFromPath,
  latestPlanRevision,
} from '../ticket-templates/roles.js';
import { scaffoldFileContent, scaffoldTemplateFiles } from '../ticket-templates/scaffold.js';

async function resolveTicketContext(opts: {
  ticket?: string;
  project?: string;
  dir?: string;
  cwd?: string;
}) {
  const cwd = opts.cwd ?? process.cwd();
  if (opts.ticket) {
    return resolveTicketTarget(opts.ticket, {
      project: opts.project,
      dir: opts.dir,
      cwd,
    });
  }
  const { initSessionDb } = await import('../dashboard/session-db.js');
  initSessionDb();
  const se = await resolveSessionEngagement(cwd);
  if (se) {
    assertMayMutate(se.session, { hasSelector: false });
  }
  return resolveTicketTarget(undefined, {
    project: opts.project,
    dir: opts.dir,
    cwd,
    resolveEngagement: async () => se?.open ?? null,
  });
}

function nextPlanFileName(stem: string, currentVersion: number): { fileName: string; version: number } {
  const next = currentVersion + 1;
  return {
    fileName: next === 1 ? `${stem}.md` : `${stem}-v${next}.md`,
    version: next,
  };
}

function planLabel(stem: string, version: number): string {
  return version === 1 ? stem : `${stem} v${version}`;
}

function planFileName(stem: string, version: number): string {
  return version === 1 ? `${stem}.md` : `${stem}-v${version}.md`;
}

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
  stem: string;
  newVersion: number;
  oldVersion: number;
  uncheckedTodos: string[];
}): string {
  const created = isoNow();
  const oldLabel = planLabel(opts.stem, opts.oldVersion);
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
**Supersedes:** [${oldLabel}](./${planFileName(opts.stem, opts.oldVersion)})

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

async function resolvePlanRole(ticketDir: string): Promise<{
  manifest: Awaited<ReturnType<typeof loadTemplate>>;
  planPath: string;
  stem: string;
  ticketSlug: string;
}> {
  const ticketMdPath = resolve(ticketDir, 'ticket.md');
  if (!(await fileExists(ticketMdPath))) {
    throw new Error(`Missing ticket.md at: ${ticketMdPath}`);
  }
  const ticketMd = await readFile(ticketMdPath, 'utf-8');
  const fm = parseTicketFrontmatter(ticketMd);
  const templateId = resolveTemplateForTicket(fm);
  const manifest = await loadTemplate(syntaurRoot(), templateId);
  const planRole = planRoleFile(manifest);
  if (!planRole) {
    throw new Error(`template ${templateId} has no plan role`);
  }
  const slugMatch = ticketMd.match(/^slug:\s*(.+?)\s*$/m);
  const ticketSlug = slugMatch ? slugMatch[1].trim() : ticketDir.split('/').pop() ?? '';
  const stem = planStemFromPath(planRole.path);
  return { manifest, planPath: planRole.path, stem, ticketSlug };
}

interface PlanCreateOptions {
  ticket?: string;
  project?: string;
  dir?: string;
  force?: boolean;
  by?: string;
}

async function runPlanMove(
  ticketId: string,
  options: Pick<PlanCreateOptions, 'project' | 'dir' | 'by'>,
): Promise<void> {
  try {
    const actor = resolveLifecycleActor({ actor: options.by });
    const callerSession = await resolveLifecycleCaller({ dir: options.dir });
    await moveTicket(ticketId, 'plan', {
      project: options.project,
      dir: options.dir,
      actor,
      callerSession,
      dispatch: postCliStageDispatch,
    });
  } catch (error) {
    if (error instanceof GateFailedError) {
      throw new Error(error.message);
    }
    throw error;
  }
}

function templateHasStage(manifest: TemplateManifest, stage: StageId): boolean {
  return manifest.stages.some((s) => s.id === stage);
}


async function runPlanCreate(options: PlanCreateOptions): Promise<void> {
  const target = await resolveTicketContext(options);
  const ticketDir = target.ticketDir;
  if (!(await fileExists(ticketDir))) {
    throw new Error(`Ticket directory does not exist: ${ticketDir}`);
  }

  const { manifest, planPath, stem, ticketSlug } = await resolvePlanRole(ticketDir);
  const destPath = resolve(ticketDir, planPath);

  if ((await fileExists(destPath)) && !options.force) {
    throw new Error(
      `${planPath} already exists. Use --force to overwrite, or \`syntaur plan version\` to create the next version.`,
    );
  }

  const templateDir = await resolveTemplateContentDir(syntaurRoot(), manifest.id);
  const timestamp = isoNow();

  const planEntry = manifest.files.find((f) => f.path === planPath);
  if (!planEntry) {
    throw new Error(`Template "${manifest.id}" has no plan file at ${planPath}`);
  }

  const planContent = await scaffoldFileContent(planEntry, {
    ticketDir,
    templateDir,
    template: manifest,
    ticketSlug,
    timestamp,
  });
  await writeFileForce(destPath, planContent);

  const ticketMdPath = resolve(ticketDir, 'ticket.md');
  const ticketContent = await readFile(ticketMdPath, 'utf-8');
  await writeFileForce(
    ticketMdPath,
    updatePlanBlock(ticketContent, {
      file: planPath,
      approvedDigest: null,
      approvedAt: null,
      approvedBy: null,
    }),
  );

  console.log(`Created ${destPath}`);
  await runPlanMove(target.id, options);
}

interface PlanVersionOptions {
  ticket?: string;
  project?: string;
  dir?: string;
  by?: string;
  force?: boolean;
}

async function runPlanVersion(options: PlanVersionOptions): Promise<void> {
  const target = await resolveTicketContext(options);
  const ticketDir = target.ticketDir;
  if (!(await fileExists(ticketDir))) {
    throw new Error(`Ticket directory does not exist: ${ticketDir}`);
  }

  const ticketMdPath = resolve(ticketDir, 'ticket.md');
  const actor = resolveLifecycleActor({ actor: options.by, dir: options.dir });

  type PendingPlanCompletion =
    | { kind: 'recorded'; entry: ReturnType<typeof recordStageEntryLocked> }
    | { kind: 'failed'; error: string }
    | undefined;

  let pendingCompletion: PendingPlanCompletion;
  let completionTicketId = '';
  let completionProjectSlug: string | null = null;
  let completionTicketSlug = '';

  await withTicketMutationLock(ticketMdPath, async () => {
    const { manifest, planPath, stem, ticketSlug } = await resolvePlanRole(ticketDir);
    const planFiles = await planRevisions(ticketDir, stem);
    if (planFiles.length === 0) {
      throw new Error(
        `No ${stem}.md (or ${stem}-v<N>.md) found in ${ticketDir}. Run plan create first.`,
      );
    }

    const current = planFiles[planFiles.length - 1];
    const next = nextPlanFileName(stem, current.version);
    const newPath = resolve(ticketDir, next.fileName);

    if ((await fileExists(newPath)) && !options.force) {
      throw new Error(`${next.fileName} already exists. Use --force to overwrite.`);
    }

    const oldPlanPath = resolve(ticketDir, current.fileName);
    const oldPlanContent = await readFile(oldPlanPath, 'utf-8');
    const oldBody = oldPlanContent.replace(/^---[\s\S]*?\n---\n?/, '');
    const carriedTodos = extractUncheckedTodos(oldBody);

    const stub = buildNewPlanStub({
      ticketSlug,
      stem,
      newVersion: next.version,
      oldVersion: current.version,
      uncheckedTodos: carriedTodos,
    });

    await writeFileForce(newPath, stub);

    console.log(`Created ${next.fileName} (superseding ${current.fileName}).`);
    console.log(`Path: ${newPath}`);
    console.log(`Carried forward: ${carriedTodos.length} unchecked task(s).`);

    const now = isoNow();
    const ticketContent = await readFile(ticketMdPath, 'utf-8');
    const fm = parseTicketFrontmatter(ticketContent);
    let updatedTicket = updatePlanBlock(ticketContent, {
      file: next.fileName,
      approvedDigest: null,
      approvedAt: null,
      approvedBy: null,
    });

    completionTicketId = fm.id;
    completionProjectSlug = fm.project;
    completionTicketSlug = fm.slug;

    if (templateHasStage(manifest, 'planning') && fm.status !== 'planning') {
      updatedTicket = updateTicketFile(updatedTicket, { status: 'planning', updated: now });
    }

    await writeFileForce(ticketMdPath, updatedTicket);

    emitPlanVersioned({
      ticketId: fm.id,
      projectSlug: fm.project,
      actor,
      file: next.fileName,
      at: now,
    });

    if (templateHasStage(manifest, 'planning') && fm.status !== 'planning') {
      try {
        pendingCompletion = {
          kind: 'recorded',
          entry: recordStageEntryLocked({
            ticketId: fm.id,
            projectSlug: fm.project,
            actor,
            at: now,
            eventType: 'moved',
            stage: 'planning',
            manifest,
            verb: 'plan-version',
            from: fm.status,
            to: 'planning',
          }),
        };
      } catch (err) {
        pendingCompletion = {
          kind: 'failed',
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }
  });

  const callerSession = await resolveLifecycleCaller({ dir: options.dir });
  if (pendingCompletion?.kind === 'recorded') {
    await completeStageEntry({
      ticketId: completionTicketId,
      ticketDir,
      projectSlug: completionProjectSlug,
      ticketSlug: completionTicketSlug,
      entry: pendingCompletion.entry,
      actor,
      callerSession,
      dispatch: postCliStageDispatch,
    });
  } else if (pendingCompletion?.kind === 'failed') {
    await completeStageEntryAfterRecordFailure({
      ticketId: completionTicketId,
      ticketDir,
      projectSlug: completionProjectSlug,
      ticketSlug: completionTicketSlug,
      actor,
      callerSession,
      dispatch: postCliStageDispatch,
      stage: 'planning',
      error: pendingCompletion.error,
    });
  }
}

export const planCommand = new Command('plan')
  .description('Manage plan files for the active ticket');

planCommand
  .command('create')
  .description('Create the initial plan file for the ticket')
  .argument('[ticket]', "Ticket id. Defaults to the session's open engagement")
  .option('--ticket <id>', 'Alias for [ticket]')
  .option('--project <slug>', 'Project slug. Required when --ticket is given for a project-nested ticket')
  .option('--dir <path>', 'Override default project directory')
  .option('--by <name>', 'Audit attribution for the planning stage move')
  .option('--force', 'Overwrite an existing plan file')
  .action(async (ticket: string | undefined, options: PlanCreateOptions) => {
    try {
      await runPlanCreate({ ...options, ticket: ticket ?? options.ticket });
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

planCommand
  .command('version')
  .description('Create the next plan revision and carry forward unchecked tasks')
  .argument('[ticket]', "Ticket id. Defaults to the session's open engagement")
  .option('--ticket <id>', 'Alias for [ticket]')
  .option('--project <slug>', 'Project slug. Required when --ticket is given for a project-nested ticket')
  .option('--dir <path>', 'Override default project directory')
  .option('--by <name>', 'Audit attribution for this action')
  .option('--force', 'Overwrite if the next revision already exists')
  .action(async (ticket: string | undefined, options: PlanVersionOptions) => {
    try {
      await runPlanVersion({ ...options, ticket: ticket ?? options.ticket });
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

export const _internal = {
  extractUncheckedTodos,
  nextPlanFileName,
  planRevisions,
  resolveTicketContext,
  runPlanVersion,
  runPlanCreate,
  resolvePlanRole,
  latestPlanRevision,
};
