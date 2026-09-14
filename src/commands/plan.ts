import { Command } from 'commander';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileExists, writeFileForce } from '../utils/fs.js';
import { recomputeTicketDir } from '../lifecycle/recompute.js';
import { updatePlanBlock, parseTicketFrontmatter } from '../lifecycle/frontmatter.js';
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
import { scaffoldTemplateFiles } from '../ticket-templates/scaffold.js';
import { renderPlanStub } from '../templates/plan.js';

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
  const { initSessionDb } = await import('../dashboard/session-db.js');
  initSessionDb();
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
  force?: boolean;
}

async function runPlanCreate(options: PlanCreateOptions): Promise<void> {
  const ticketDir = await resolveTicketDir(options);
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

  if (options.force && (await fileExists(destPath))) {
    await writeFileForce(
      destPath,
      renderPlanStub({ ticketSlug, timestamp }),
    );
  } else {
    await scaffoldTemplateFiles({
      ticketDir,
      templateDir,
      template: manifest,
      ticketSlug,
      timestamp,
      only: [planPath],
    });
  }

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

  const { planPath, stem, ticketSlug } = await resolvePlanRole(ticketDir);
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

  const ticketMdPath = resolve(ticketDir, 'ticket.md');
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

  await recomputeTicketDir(ticketDir, 'plan-version', null);
}

export const planCommand = new Command('plan')
  .description('Manage plan files for the active ticket');

planCommand
  .command('create')
  .description('Create the initial plan file for the ticket')
  .option('--ticket <id>', "Ticket id. Defaults to the session's open engagement")
  .option('--project <slug>', 'Project slug. Required when --ticket is given for a project-nested ticket')
  .option('--force', 'Overwrite an existing plan file')
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
  .description('Create the next plan revision and carry forward unchecked tasks')
  .option('--ticket <id>', "Ticket id. Defaults to the session's open engagement")
  .option('--project <slug>', 'Project slug. Required when --ticket is given for a project-nested ticket')
  .option('--force', 'Overwrite if the next revision already exists')
  .action(async (options: PlanVersionOptions) => {
    try {
      await runPlanVersion(options);
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

export const _internal = {
  extractUncheckedTodos,
  nextPlanFileName,
  planRevisions,
  resolveTicketDir,
  runPlanVersion,
  runPlanCreate,
  resolvePlanRole,
  latestPlanRevision,
};

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
