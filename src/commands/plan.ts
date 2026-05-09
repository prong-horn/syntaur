import { Command } from 'commander';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileExists, writeFileForce } from '../utils/fs.js';
import { defaultProjectDir, assignmentsDir } from '../utils/paths.js';

interface ContextFile {
  projectSlug?: string;
  assignmentSlug?: string;
  assignmentDir?: string;
}

async function readContextAssignmentDir(cwd: string): Promise<string | null> {
  const path = resolve(cwd, '.syntaur', 'context.json');
  if (!(await fileExists(path))) return null;
  try {
    const raw = await readFile(path, 'utf-8');
    const ctx = JSON.parse(raw) as ContextFile;
    if (typeof ctx.assignmentDir === 'string' && ctx.assignmentDir.length > 0) {
      return ctx.assignmentDir;
    }
    return null;
  } catch {
    return null;
  }
}

async function resolveAssignmentDir(opts: {
  assignment?: string;
  project?: string;
  cwd?: string;
}): Promise<string> {
  const cwd = opts.cwd ?? process.cwd();
  if (opts.assignment) {
    if (opts.project) {
      return resolve(defaultProjectDir(), opts.project, 'assignments', opts.assignment);
    }
    // Standalone (assignment is UUID under ~/.syntaur/assignments/)
    return resolve(assignmentsDir(), opts.assignment);
  }
  const fromCtx = await readContextAssignmentDir(cwd);
  if (fromCtx) return fromCtx;
  throw new Error(
    'No active assignment. Pass --assignment <slug> --project <slug> or run from a workspace with .syntaur/context.json.',
  );
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
 * Find any line under the `## Todos` section that references an existing plan
 * (by `[plan](./plan.md)` or `[plan v<N>](./plan-v<N>.md)`) and which is part
 * of the current plan's four-todo cycle. Returns the rewritten section.
 *
 * The four-todo cycle uses the verbs: Create, Review, Implement, Review implementation of.
 */
function rewriteAssignmentTodos(
  content: string,
  oldVersion: number,
  newVersion: number,
): { updated: string; rewrote: number; appended: number } {
  const lines = content.split('\n');
  const todosHeaderIdx = lines.findIndex((l) => /^##\s+Todos\s*$/.test(l));
  if (todosHeaderIdx === -1) {
    throw new Error('assignment.md has no `## Todos` section to rewrite.');
  }

  // Find the end of the section: next `## ` or end of file.
  let endIdx = lines.length;
  for (let i = todosHeaderIdx + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) {
      endIdx = i;
      break;
    }
  }

  const oldFile = planFileName(oldVersion);
  const oldLink = `./${oldFile}`;
  const newFile = planFileName(newVersion);
  const newLabel = planLinkText(newVersion);
  const supersededTag = `(superseded by plan-v${newVersion})`;

  let rewrote = 0;
  for (let i = todosHeaderIdx + 1; i < endIdx; i++) {
    const line = lines[i];
    // Match a todo line referencing the old plan file. Patterns include both
    // `- [ ] Create [plan](./plan.md)` and `- [x] Create [plan](./plan.md)`.
    if (line.includes(oldLink) && /^\s*-\s*\[[ xX]\]/.test(line)) {
      // Already-superseded lines get skipped.
      if (line.includes('(superseded by plan-v')) continue;
      // Strikethrough the existing label, mark done, append superseded tag.
      // Replace the leading `- [ ]` or `- [x]` with `- [x]`.
      let next = line.replace(/^(\s*-\s*)\[[ xX]\]/, '$1[x]');
      // Wrap the body text after the checkbox in `~~...~~` if not already wrapped.
      next = next.replace(
        /^(\s*-\s*\[x\]\s*)(.*)$/,
        (_m, prefix: string, rest: string) => {
          const body = rest.endsWith(' ') ? rest.trimEnd() : rest;
          if (body.startsWith('~~') && body.endsWith('~~')) {
            return `${prefix}${body} ${supersededTag}`;
          }
          return `${prefix}~~${body}~~ ${supersededTag}`;
        },
      );
      lines[i] = next;
      rewrote += 1;
    }
  }

  // Append the new four-todo cycle just before endIdx, keeping a blank line if needed.
  const newTodos = [
    `- [ ] Create [${newLabel}](./${newFile})`,
    `- [ ] Review [${newLabel}](./${newFile})`,
    `- [ ] Implement [${newLabel}](./${newFile})`,
    `- [ ] Review implementation of [${newLabel}](./${newFile})`,
  ];

  // Insert at endIdx (before the next `##` heading or EOF). If the line just
  // before endIdx is non-blank, insert a blank separator first.
  const insertAt = endIdx;
  const prevLine = lines[insertAt - 1] ?? '';
  const toInsert: string[] = [];
  if (prevLine.trim() !== '') toInsert.push('');
  toInsert.push(...newTodos);

  lines.splice(insertAt, 0, ...toInsert);

  return {
    updated: lines.join('\n'),
    rewrote,
    appended: newTodos.length,
  };
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

  // Rewrite assignment.md ## Todos section.
  const { updated, rewrote, appended } = rewriteAssignmentTodos(
    assignmentMd,
    current.version,
    next.version,
  );

  await writeFileForce(newPath, stub);
  await writeFileForce(assignmentMdPath, updated);

  console.log(
    `Created ${next.fileName} (superseding ${current.fileName}). Rewrote ${rewrote} prior todo(s); appended ${appended} new todo(s).`,
  );
  console.log(`Path: ${newPath}`);
  console.log(`Carried forward: ${carriedTodos.length} unchecked task(s).`);
}

export const planCommand = new Command('plan')
  .description('Manage plan files for the active assignment');

planCommand
  .command('version')
  .description(
    'Create the next plan-v<N>.md, supersede the prior plan in assignment.md ## Todos, and carry forward unchecked tasks',
  )
  .option('--assignment <slug>', 'Assignment slug (UUID for standalone). Defaults to .syntaur/context.json')
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
  rewriteAssignmentTodos,
  extractUncheckedTodos,
  nextPlanFileName,
  listPlanFiles,
  resolveAssignmentDir,
  runPlanVersion,
};
