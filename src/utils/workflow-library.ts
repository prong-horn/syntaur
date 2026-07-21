/**
 * Node-only per-file workflow library loader (Phase 1 stage engine, WS-0).
 *
 * This is the disk boundary for the new stage model: it reads
 * `~/.syntaur/workflows/*.md` and parses each into a {@link StageWorkflow}. It is
 * kept SEPARATE from the browser-safe `workflow-resolve.ts` (which the dashboard
 * SPA imports via `@shared`) precisely so no `fs` leaks into that bundle
 * (codex-r1 correction). `workflow-resolve.ts` stays pure and operates on an
 * in-memory library; Node-boundary callers (CLI / dashboard server / doctor)
 * source it here.
 *
 * **Single-source invariant (§4.6).** There must be no window where BOTH the
 * per-file dir and a `config.md` `workflows:`/legacy `statuses:` block are live.
 * When both are present the loader HARD-ERRORS. When only the dir exists it is
 * authoritative; when the dir is absent this returns `{}` — the legacy ladder
 * library (`getWorkflowLibrary` in `workflow-resolve.ts`) is untouched and
 * remains the source of truth until WS-3's migration relocates workflows into
 * per-file yaml and deletes the config block in one commit (decision D1). No
 * live per-file workflow exists yet — WS-3 writes the first one via WS-0.5.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { syntaurRoot, workflowsDir } from './paths.js';
import { parseWorkflowFile } from './workflow-file.js';
import type { StageWorkflow } from './stage-model.js';

/** The minimal config slice the dual-source guard inspects. */
export interface WorkflowLibraryConfigInput {
  workflows?: Record<string, unknown> | null;
  statuses?: unknown;
}

export const DUAL_SOURCE_ERROR =
  'workflow config split across ~/.syntaur/workflows/ and config.md — run `syntaur migrate-workflows`';

/** Sorted `*.md` basenames in the workflows dir; `[]` when the dir is absent. */
function listWorkflowFiles(dir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return []; // dir absent → no per-file workflows
  }
  return entries.filter((f) => f.endsWith('.md') && !f.startsWith('.')).sort();
}

/**
 * A live `config.md` block that would collide with the per-file dir.
 *
 * Decided by the PHYSICAL ambient config.md ONLY — never by the caller's
 * in-memory config object. The dir is ambient state (`syntaurRoot()`), so the
 * colliding block must be judged from the same root: an injected config that
 * came from anywhere else (a test fixture, a stale pre-migration cache in a
 * long-running dashboard) says nothing about whether THIS machine is
 * dual-sourced. Trusting the object produced false DUAL_SOURCE errors after
 * the 2026-07-21 live migration (fixture config block + the real migrated
 * dir), and would brick a stale-config dashboard instead of letting the dir
 * win — the correct post-migration outcome. The physical check also catches
 * empty/unparseable blocks the parsers return null for (mirroring the doctor
 * `single-status-source` regex), so it is strictly the stronger signal.
 */
function hasConfigBlock(): boolean {
  return configFileHasPhysicalBlock();
}

function configFileHasPhysicalBlock(): boolean {
  const configPath = resolve(syntaurRoot(), 'config.md');
  let raw: string;
  try {
    raw = readFileSync(configPath, 'utf-8');
  } catch {
    return false; // config.md absent → no block
  }
  const fm = raw.match(/^---\n([\s\S]*?)\n---/);
  if (!fm) return false;
  return /^statuses:\s*$/m.test(fm[1]) || /^workflows:\s*$/m.test(fm[1]);
}

/** The per-file library plus each file's parse issues (keyed by filename stem). */
interface LoadedWorkflows {
  library: Record<string, StageWorkflow>;
  /** stem → non-empty list of `parseWorkflowFile` issues (surfaced by doctor). */
  issues: Record<string, string[]>;
}

// Dir-signature cache: invalidated by the 0.7 watcher / 0.5 writer, and
// automatically when a file's mtime/size changes out from under us.
let cache: { signature: string; loaded: LoadedWorkflows } | null = null;

/** Clear the loader cache. Called by the workflows watcher and per-file writer. */
export function invalidateWorkflowLibraryCache(): void {
  cache = null;
}

function dirSignature(dir: string, files: string[]): string {
  const parts = files.map((f) => {
    const s = statSync(join(dir, f));
    return `${f}:${s.mtimeMs}:${s.size}`;
  });
  return `${dir}::${parts.join('|')}`;
}

/**
 * Read + parse every per-file workflow, returning the stem-keyed library AND the
 * per-file parse issues. Shared spine of {@link loadWorkflowLibrary} /
 * {@link loadWorkflowIssues}.
 *
 * - dir has files **and** a PHYSICAL ambient `config.md` block → **throws**
 *   {@link DUAL_SOURCE_ERROR} (the injected config object is never consulted
 *   for this — see {@link hasConfigBlock}).
 * - dir has files (no block) → parse each `<id>.md`, keyed by its FILENAME stem
 *   (the authoritative on-disk identity — unique per dir, referenced by bindings,
 *   and what `writeWorkflowFile` writes).
 * - dir absent/empty → empty (legacy ladder library untouched; see module note).
 */
function loadWorkflows(_config: WorkflowLibraryConfigInput): LoadedWorkflows {
  const dir = workflowsDir();
  const files = listWorkflowFiles(dir);

  if (files.length > 0 && hasConfigBlock()) {
    throw new Error(DUAL_SOURCE_ERROR);
  }
  if (files.length === 0) return { library: {}, issues: {} };

  const signature = dirSignature(dir, files);
  if (cache && cache.signature === signature) return cache.loaded;

  const library: Record<string, StageWorkflow> = {};
  const issues: Record<string, string[]> = {};
  for (const file of files) {
    const raw = readFileSync(join(dir, file), 'utf-8');
    const parsed = parseWorkflowFile(raw);
    // Key by the filename stem, NOT `workflow.id`: filenames are unique within
    // the dir, so this can never silently drop a workflow the way keying by a
    // (possibly duplicated) internal `id:` would. A stem≠`id:` divergence is a
    // doctor structural finding (workflows.stage-structure).
    const stem = file.replace(/\.md$/, '');
    library[stem] = parsed.workflow;
    if (parsed.issues.length > 0) issues[stem] = parsed.issues;
  }
  const loaded: LoadedWorkflows = { library, issues };
  cache = { signature, loaded };
  return loaded;
}

/** The stem-keyed per-file stage-workflow library. Throws on dual sources. */
export function loadWorkflowLibrary(
  config: WorkflowLibraryConfigInput,
): Record<string, StageWorkflow> {
  return loadWorkflows(config).library;
}

/**
 * Per-file `parseWorkflowFile` issues, keyed by filename stem (only stems with at
 * least one issue). Shares the loader cache. Surfaced by the doctor so a
 * malformed file (e.g. a missing `id:`) is never accepted silently — the
 * "surface in issues" half of the no-silent-deletion contract.
 */
export function loadWorkflowIssues(
  config: WorkflowLibraryConfigInput,
): Record<string, string[]> {
  return loadWorkflows(config).issues;
}
