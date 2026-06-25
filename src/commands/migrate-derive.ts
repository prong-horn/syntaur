/**
 * One-time, idempotent migration to derived status (design v3, Piece 5).
 *
 * Seeds asserted facts from each assignment's CURRENT command-set status so
 * in-flight work keeps its standing (codex round-2 finding: re-deriving from
 * objective facts alone would lose implementation/review state):
 *   - blocked w/o reason          → blockedReason: "(unknown)"
 *   - in_progress/review-ish      → implementationStarted: true
 *   - review-ish                  → reviewRequested: true
 * Then recomputes everything and emits a divergence report (old stored vs
 * newly derived). Statuses are re-derived, NOT auto-pinned — divergences are
 * for spot-checking, with `syntaur status pin` as the escape hatch.
 */

import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  DEFAULT_DERIVE_CONFIG,
  buildDefaultStatusConfig,
  readConfig,
  toTitleCase,
  writeStatusConfig,
} from '../utils/config.js';
import { expandHome, assignmentsDir as assignmentsDirFn } from '../utils/paths.js';
import { fileExists } from '../utils/fs.js';
import { parseAssignmentFrontmatter, updateAssignmentFile } from '../lifecycle/frontmatter.js';
import { computeFacts } from '../lifecycle/facts.js';
import { deriveDimensions } from '../lifecycle/derive.js';
import {
  markDeriveMigrated,
  recomputeAndWrite,
  resolveDeriveContext,
  type DeriveContext,
} from '../lifecycle/recompute.js';

export interface MigrateDeriveOptions {
  dir?: string;
  /** Report what would change without writing anything. */
  dryRun?: boolean;
}

/** Statuses that imply implementation already began / review already entered.
 * Heuristic over common ids; anything custom can be pinned afterwards. */
const IMPLEMENTATION_STATUSES = new Set(['in_progress', 'review', 'code_review']);
const REVIEW_STATUSES = new Set(['review', 'code_review']);

interface DivergenceRow {
  ref: string;
  before: string;
  after: string;
  phase: string | null;
}

async function listTargets(projectsDir: string, standaloneDir: string): Promise<Array<{ path: string; projectDir: string | null; ref: string }>> {
  const targets: Array<{ path: string; projectDir: string | null; ref: string }> = [];
  let projects: string[] = [];
  try {
    projects = await readdir(projectsDir);
  } catch {
    /* none */
  }
  for (const project of projects) {
    const projectDir = resolve(projectsDir, project);
    let slugs: string[] = [];
    try {
      slugs = await readdir(resolve(projectDir, 'assignments'));
    } catch {
      continue;
    }
    for (const slug of slugs) {
      const path = resolve(projectDir, 'assignments', slug, 'assignment.md');
      if (await fileExists(path)) targets.push({ path, projectDir, ref: `${project}/${slug}` });
    }
  }
  let ids: string[] = [];
  try {
    ids = await readdir(standaloneDir);
  } catch {
    /* none */
  }
  for (const id of ids) {
    const path = resolve(standaloneDir, id, 'assignment.md');
    if (await fileExists(path)) targets.push({ path, projectDir: null, ref: id });
  }
  return targets;
}

function seedFacts(content: string, status: string, blockedReason: string | null): string {
  let next = content;
  const updates: Parameters<typeof updateAssignmentFile>[1] = {};
  if (status === 'blocked' && blockedReason === null) {
    updates.blockedReason = '(unknown)';
  }
  if (IMPLEMENTATION_STATUSES.has(status)) {
    updates.implementationStarted = true;
  }
  if (REVIEW_STATUSES.has(status)) {
    updates.reviewRequested = true;
  }
  // Migration policy: a migrated assignment has no rework history — materialize
  // the scalar explicitly as false (stage-fact-status-bridge).
  updates.reworkRequested = false;
  if (Object.keys(updates).length > 0) {
    next = updateAssignmentFile(next, updates);
  }
  return next;
}

export async function migrateDeriveCommand(options: MigrateDeriveOptions): Promise<void> {
  const config = await readConfig();
  const projectsDir = options.dir ? expandHome(options.dir) : config.defaultProjectDir;
  const standaloneDir = assignmentsDirFn();
  const context: DeriveContext = await resolveDeriveContext();

  // Materialize the parked headline status (codex finding: without a defined
  // id, parking silently falls back to the phase). Adds the definition + order
  // entry to the statuses block, preserving any custom derive rules.
  const statusConfig = config.statuses ?? buildDefaultStatusConfig();
  const parkedId = (config.statuses?.derive ?? DEFAULT_DERIVE_CONFIG).headline.parked;
  if (!statusConfig.statuses.some((s) => s.id === parkedId)) {
    if (options.dryRun) {
      console.log(`[dry-run] would add missing status definition "${parkedId}" (parked headline target).`);
    } else {
      await writeStatusConfig({
        ...statusConfig,
        statuses: [
          ...statusConfig.statuses,
          { id: parkedId, label: toTitleCase(parkedId), color: 'slate' },
        ],
        // place parked just before any terminal statuses in the order
        order: [...statusConfig.order, parkedId],
        derive: config.statuses?.derive ?? null,
      });
      context.knownStatusIds = new Set([...context.knownStatusIds, parkedId]);
      console.log(`Added missing status definition "${parkedId}" (parked headline target).`);
    }
  }

  const targets = await listTargets(projectsDir, standaloneDir);
  const divergences: DivergenceRow[] = [];
  let seeded = 0;
  let recomputed = 0;
  let terminal = 0;

  for (const target of targets) {
    let content: string;
    try {
      content = await readFile(target.path, 'utf-8');
    } catch {
      continue;
    }
    const fm = parseAssignmentFrontmatter(content);

    if (context.terminalStatuses.has(fm.status)) {
      terminal++; // terminal assignments are untouched — derivation defers
      continue;
    }

    const seededContent = seedFacts(content, fm.status, fm.blockedReason);
    const willSeed = seededContent !== content;

    if (options.dryRun) {
      // Read-only preview: compute what WOULD be derived post-seed.
      const seededFm = parseAssignmentFrontmatter(seededContent);
      const body = seededContent.replace(/^---\n[\s\S]*?\n---/, '');
      const facts = await computeFacts({
        assignmentDir: resolve(target.path, '..'),
        frontmatter: seededFm,
        body,
        projectDir: target.projectDir,
        terminalStatuses: context.terminalStatuses,
        declarations: context.factDeclarations,
      });
      const dims = deriveDimensions({
        facts,
        derive: context.derive,
        currentStatus: seededFm.status,
        terminalStatuses: context.terminalStatuses,
        knownStatusIds: context.knownStatusIds,
        override: seededFm.override,
        registry: context.registry,
      });
      if (dims && dims.status !== fm.status) {
        divergences.push({ ref: target.ref, before: fm.status, after: dims.status, phase: dims.phase });
      }
      if (willSeed) seeded++;
      continue;
    }

    if (willSeed) seeded++;
    // Seeding rides inside the recompute transaction (lock + CAS), same as
    // every other fact mutation — no pre-lock write.
    const result = await recomputeAndWrite(target.path, {
      cause: 'migrate-derive',
      by: 'system',
      projectDir: target.projectDir,
      context,
      mutate: (current) => {
        const currentFm = parseAssignmentFrontmatter(current);
        return seedFacts(current, currentFm.status, currentFm.blockedReason);
      },
    });
    if (result.changed) {
      recomputed++;
      divergences.push({
        ref: target.ref,
        before: fm.status,
        after: result.status,
        phase: result.dimensions?.phase ?? null,
      });
    }
  }

  if (!options.dryRun) {
    // Unlocks the dashboard's implicit recompute triggers (boot/watcher/config
    // sweeps) — they stay dormant until facts have been seeded.
    await markDeriveMigrated();
  }

  const mode = options.dryRun ? '[dry-run] ' : '';
  console.log(
    `${mode}migrate-derive: ${targets.length} assignment(s) scanned, ${seeded} fact-seeded, ` +
      `${options.dryRun ? divergences.length + ' would change' : recomputed + ' re-derived'}, ${terminal} terminal (untouched).`,
  );
  if (divergences.length > 0) {
    console.log('\nDivergence report (stored → derived):');
    for (const d of divergences) {
      console.log(`  ${d.ref}: ${d.before} → ${d.after}${d.phase ? ` (phase: ${d.phase})` : ''}`);
    }
    console.log('\nSpot-check these; `syntaur status pin` is the escape hatch for any that are wrong.');
  }
}
