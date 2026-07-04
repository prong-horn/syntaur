import { Command } from 'commander';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  parseStatusConfig,
  serializeStatusConfig,
  writeStatusConfig,
  deleteStatusConfig,
  buildDefaultStatusConfig,
  readConfig,
  type StatusConfig,
  type StatusDefinition,
  type SyntaurConfig,
} from '../utils/config.js';
import { writeWorkflowBundle } from '../utils/workflow-write.js';
import { DEFAULT_WORKFLOW_ID } from '../utils/workflow-resolve.js';
import { makeWorkflowContextResolver } from '../lifecycle/workflow-context.js';
import { syntaurRoot, assignmentsDir } from '../utils/paths.js';
import { fileExists, writeFileForce } from '../utils/fs.js';
import { nowTimestamp } from '../utils/timestamp.js';
import {
  parseAssignmentFrontmatter,
  renameStatusInHistory,
  updateAssignmentFile,
  updateOverride,
} from '../lifecycle/frontmatter.js';

/** Relabel every reference to a status id in one assignment file: headline
 * `status` and cached `phase` (only when they match), plus all history keys
 * via renameStatusInHistory. No history entry is appended (relabel ≠ transition). */
function renameAssignmentStatusRefs(content: string, id: string, newId: string, now: string): string {
  const fm = parseAssignmentFrontmatter(content);
  const updates: Parameters<typeof updateAssignmentFile>[1] = { updated: now };
  if (fm.status === id) updates.status = newId;
  if (fm.phase === id) updates.phase = newId;
  let next = updateAssignmentFile(content, updates);
  // A pin targeting the renamed id must follow it, or the override silently
  // dissolves on the next recompute (codex r2 finding 4).
  if (fm.override?.status === id) {
    next = updateOverride(next, { ...fm.override, status: newId });
  }
  return renameStatusInHistory(next, id, newId);
}
import {
  scanAssignmentsReferencingStatus,
  type AffectedAssignment,
  type WorkflowScanScope,
} from '../utils/status-config-resolution.js';

/**
 * The project + standalone dirs the dashboard's status router scans
 * (`config.defaultProjectDir` + the standalone assignments dir). Using the
 * *configured* project dir — not the fixed paths.defaultProjectDir() — keeps the
 * CLI's remove/rename scans in sync with the dashboard for custom project roots.
 */
async function scanDirs(): Promise<{ projectsDir: string; standaloneDir: string }> {
  const config = await readConfig();
  return { projectsDir: config.defaultProjectDir, standaloneDir: assignmentsDir() };
}

function fail(error: unknown): never {
  console.error('Error:', error instanceof Error ? error.message : String(error));
  process.exit(1);
}

function configPath(): string {
  return resolve(syntaurRoot(), 'config.md');
}

/** Read the explicit `statuses:` block from config.md, or null if none exists. */
async function readStatusBlock(): Promise<StatusConfig | null> {
  const p = configPath();
  if (!(await fileExists(p))) return null;
  const content = await readFile(p, 'utf-8');
  return parseStatusConfig(content);
}

// ----- effective status bundle (workflow-aware redirect) --------------------
//
// The multi-workflow migration lifted the legacy top-level `statuses:` block into
// `workflows.default`, so `syntaur status` must operate on the GLOBAL default
// workflow (config.defaultWorkflow, not the literal `default`). These loaders are
// the single seam that resolves that bundle — and NEVER fall back to the legacy
// block when a `workflows:` map exists (that fallback is the split-brain this
// redirect kills, so getWorkflowBundle is deliberately NOT used here).

type BundleOrigin = 'workflow' | 'legacy' | 'default';

interface EffectiveBundle {
  /** The status bundle to read/mutate (workflow `label` stripped off). */
  block: StatusConfig;
  /** Where it came from — decides the write path and `list` source. */
  origin: BundleOrigin;
  /** The workflow id status verbs target (the global default, or `default`). */
  targetId: string;
  /** The workflow's display label, preserved across writes (workflow origin only). */
  label: string | null;
}

/** The workflow id `syntaur status` acts on: the GLOBAL default workflow (last
 * rung of binding resolution), NOT the literal `default` — so a config with
 * `defaultWorkflow: bug` edits `bug`. */
function statusTargetWorkflowId(config: SyntaurConfig): string {
  return config.defaultWorkflow ?? DEFAULT_WORKFLOW_ID;
}

function hasWorkflowsMap(config: SyntaurConfig): boolean {
  return !!config.workflows && Object.keys(config.workflows).length > 0;
}

/**
 * Resolve the status bundle `syntaur status` acts on. Returns null when neither a
 * `workflows:` map nor a legacy `statuses:` block is present.
 */
async function loadEffectiveBundle(config: SyntaurConfig): Promise<EffectiveBundle | null> {
  const targetId = statusTargetWorkflowId(config);
  if (hasWorkflowsMap(config)) {
    const wf = config.workflows![targetId];
    if (!wf) {
      throw new Error(
        `Global default workflow "${targetId}" is not defined under \`workflows:\` in config.md — ` +
          `fix \`defaultWorkflow:\` or create the workflow via the dashboard.`,
      );
    }
    const { label, ...block } = wf;
    return { block, origin: 'workflow', targetId, label };
  }
  const legacy = await readStatusBlock();
  if (legacy) return { block: legacy, origin: 'legacy', targetId, label: null };
  return null;
}

/**
 * Load the effective bundle or throw the "run init first" guidance. Mutating verbs
 * (add/set/reorder/remove/rename/transition) require an explicit source because
 * the runtime is all-or-nothing — once any status config exists the built-in
 * defaults are no longer merged.
 */
async function requireEffectiveBundle(config: SyntaurConfig): Promise<EffectiveBundle> {
  const bundle = await loadEffectiveBundle(config);
  if (!bundle) {
    throw new Error(
      'No custom status block in config.md. Run `syntaur status init` first to materialize the built-in defaults.',
    );
  }
  return bundle;
}

/** `status list`: neither source → synthesize built-ins (`source: 'default'`),
 * preserving the documented pre-init list behavior. */
async function optionalEffectiveBundle(config: SyntaurConfig): Promise<EffectiveBundle> {
  const bundle = await loadEffectiveBundle(config);
  if (bundle) return bundle;
  return {
    block: buildDefaultStatusConfig(),
    origin: 'default',
    targetId: statusTargetWorkflowId(config),
    label: null,
  };
}

function printRedirectNotice(targetId: string): void {
  console.error(
    `note: \`syntaur status\` edits workflow '${targetId}' (the global default); ` +
      `prefer the dashboard Workflow editor (future: \`syntaur workflow\` subverbs).`,
  );
}

/**
 * Persist a mutated bundle back to the source it came from: the workflow library
 * (label preserved + redirect notice) for a workflows-map config, or the legacy
 * top-level block (byte-identical to prior behavior) for a legacy config.
 */
async function persistBundle(bundle: EffectiveBundle, after: StatusConfig): Promise<void> {
  if (bundle.origin === 'workflow') {
    await writeWorkflowBundle(bundle.targetId, after, { label: bundle.label ?? bundle.targetId });
    printRedirectNotice(bundle.targetId);
    return;
  }
  await writeStatusConfig(after);
}

/** Scope a remove/rename scan to the target workflow's assignments when a
 * `workflows:` map exists, so a rename/remove never rewrites or blocks on tickets
 * bound to OTHER workflows sharing the same status id. Legacy configs have one
 * lifecycle → no scoping needed (byte-identical to prior behavior). */
function scanScope(config: SyntaurConfig, bundle: EffectiveBundle): WorkflowScanScope {
  if (bundle.origin !== 'workflow') return {};
  return { resolver: makeWorkflowContextResolver(config), workflowId: bundle.targetId };
}

/** Minimal LCS-based line diff (`- ` removed, `+ ` added, `  ` unchanged). */
function lineDiff(before: string, after: string): string {
  const a = before.split('\n');
  const b = after.split('\n');
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push(`  ${a[i]}`);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push(`- ${a[i]}`);
      i++;
    } else {
      out.push(`+ ${b[j]}`);
      j++;
    }
  }
  while (i < n) out.push(`- ${a[i++]}`);
  while (j < m) out.push(`+ ${b[j++]}`);
  return out.join('\n');
}

/**
 * The transitions that are actually in effect for a block: its own if non-empty,
 * else the built-in defaults (matching the dashboard, which materializes default
 * transitions when a custom statuses block omits `transitions:`). Mutating verbs
 * must operate on these so that, e.g., `transition add` doesn't silently wipe the
 * default transitions and `remove`/`rename` don't leave defaults pointing at a
 * dropped/old id.
 */
function effectiveTransitions(block: StatusConfig): StatusConfig['transitions'] {
  return block.transitions.length > 0 ? block.transitions : buildDefaultStatusConfig().transitions;
}

/** Render the `statuses:` block (or "(none)" when null) for diffing. */
function renderBlock(cfg: StatusConfig | null): string {
  return cfg ? serializeStatusConfig(cfg) : '(no statuses block)';
}

function printBlockDiff(before: StatusConfig | null, after: StatusConfig | null): void {
  console.log('--- config.md (statuses)');
  console.log('+++ config.md (statuses)');
  console.log(lineDiff(renderBlock(before), renderBlock(after)));
}

// ----- list -----------------------------------------------------------------

export interface StatusListResult {
  statuses: StatusDefinition[];
  order: string[];
  transitions: StatusConfig['transitions'];
  source: 'config' | 'default';
}

export async function runStatusList(): Promise<StatusListResult> {
  const config = await readConfig();
  const bundle = await optionalEffectiveBundle(config);
  const cfg = bundle.block;
  // Parity with the dashboard's getStatusConfig(): a custom statuses block with
  // no `transitions:` falls back to the built-in default transitions (the CLI
  // must not report `[]` where the dashboard materializes defaults).
  const transitions =
    cfg.transitions.length > 0 ? cfg.transitions : buildDefaultStatusConfig().transitions;
  return {
    statuses: cfg.statuses,
    order: cfg.order,
    transitions,
    // 'config' when a real workflow/legacy block backs it; 'default' only when
    // neither source exists (synthesized built-ins — pre-init behavior).
    source: bundle.origin === 'default' ? 'default' : 'config',
  };
}

// ----- init / reset ---------------------------------------------------------

export async function runStatusInit(opts: { force?: boolean; dryRun?: boolean }): Promise<void> {
  const config = await readConfig();
  // A `workflows:` map is the authoritative source; `init` would create a second,
  // conflicting top-level `statuses:` block that getWorkflowLibrary ignores.
  if (hasWorkflowsMap(config)) {
    throw new Error(
      `Statuses live under \`workflows:\` — \`syntaur status\` verbs already edit workflow ` +
        `'${statusTargetWorkflowId(config)}'. \`init\` would create a second, conflicting source; ` +
        `edit the workflow directly (add/set/reorder/…) or use the dashboard Workflow editor.`,
    );
  }
  const existing = await readStatusBlock();
  if (existing && !opts.force) {
    throw new Error(
      'A custom statuses block already exists. Re-run with --force to overwrite it, or `syntaur status reset` to clear it first.',
    );
  }
  const next = buildDefaultStatusConfig();
  if (opts.dryRun) {
    printBlockDiff(existing, next);
    return;
  }
  await writeStatusConfig(next);
}

export async function runStatusReset(opts: { dryRun?: boolean }): Promise<void> {
  const config = await readConfig();
  if (hasWorkflowsMap(config)) {
    const targetId = statusTargetWorkflowId(config);
    const wf = config.workflows![targetId];
    if (!wf) {
      throw new Error(
        `Global default workflow "${targetId}" is not defined under \`workflows:\` in config.md — ` +
          `fix \`defaultWorkflow:\` or create the workflow via the dashboard.`,
      );
    }
    const next = buildDefaultStatusConfig();
    if (opts.dryRun) {
      const { label: _label, ...currentBlock } = wf;
      printBlockDiff(currentBlock, next);
      console.log(`\n(resets workflow '${targetId}' to built-in statuses/transitions; clears custom derive/facts.)`);
      return;
    }
    await writeWorkflowBundle(targetId, next, { label: wf.label });
    console.error(
      `note: reset workflow '${targetId}' (the global default) to built-in statuses/transitions; custom derive/facts cleared.`,
    );
    return;
  }
  const existing = await readStatusBlock();
  if (!existing) {
    if (opts.dryRun) console.log('No statuses block present — nothing to reset.');
    return;
  }
  if (opts.dryRun) {
    printBlockDiff(existing, null);
    return;
  }
  await deleteStatusConfig();
}

// ----- add / set / reorder --------------------------------------------------

export interface StatusAddOptions {
  label?: string;
  color?: string;
  icon?: string;
  description?: string;
  terminal?: boolean;
  after?: string;
  before?: string;
  atEnd?: boolean;
  dryRun?: boolean;
}

function insertIntoOrder(
  order: string[],
  id: string,
  opts: { after?: string; before?: string },
): string[] {
  const next = order.filter((o) => o !== id);
  if (opts.after !== undefined) {
    const idx = next.indexOf(opts.after);
    if (idx === -1) throw new Error(`--after "${opts.after}" is not an existing status id`);
    next.splice(idx + 1, 0, id);
  } else if (opts.before !== undefined) {
    const idx = next.indexOf(opts.before);
    if (idx === -1) throw new Error(`--before "${opts.before}" is not an existing status id`);
    next.splice(idx, 0, id);
  } else {
    next.push(id);
  }
  return next;
}

export async function runStatusAdd(id: string, opts: StatusAddOptions): Promise<void> {
  if (!id || !/^[a-zA-Z0-9_-]+$/.test(id)) {
    throw new Error(`Invalid status id "${id}" — use letters, digits, "_" or "-".`);
  }
  if (!opts.label) throw new Error('--label is required');
  const positionFlags = [opts.after !== undefined, opts.before !== undefined, opts.atEnd === true].filter(
    Boolean,
  ).length;
  if (positionFlags > 1) {
    throw new Error('--after, --before, and --at-end are mutually exclusive');
  }

  const config = await readConfig();
  const bundle = await requireEffectiveBundle(config);
  const before = bundle.block;
  if (before.statuses.some((s) => s.id === id)) {
    throw new Error(`Status "${id}" already exists. Use \`syntaur status set\` to edit it.`);
  }

  const def: StatusDefinition = { id, label: opts.label };
  if (opts.color) def.color = opts.color;
  if (opts.icon) def.icon = opts.icon;
  if (opts.description) def.description = opts.description;
  if (opts.terminal) def.terminal = true;

  const after: StatusConfig = {
    statuses: [...before.statuses, def],
    order: insertIntoOrder(before.order, id, { after: opts.after, before: opts.before }),
    transitions: before.transitions,
    derive: before.derive ?? null,
    // Preserve custom fact declarations across status mutations — same
    // silent-deletion bug class as derive (Settings/CLI rebuild the block).
    facts: before.facts ?? null,
  };

  if (opts.dryRun) {
    printBlockDiff(before, after);
    return;
  }
  await persistBundle(bundle, after);
}

export interface StatusSetOptions {
  id?: string;
  label?: string;
  color?: string;
  icon?: string;
  description?: string;
  terminal?: string;
  dryRun?: boolean;
}

export async function runStatusSet(opts: StatusSetOptions): Promise<void> {
  if (!opts.id) throw new Error('--id is required');
  const config = await readConfig();
  const bundle = await requireEffectiveBundle(config);
  const before = bundle.block;
  const idx = before.statuses.findIndex((s) => s.id === opts.id);
  if (idx === -1) throw new Error(`Status "${opts.id}" does not exist.`);

  const updated: StatusDefinition = { ...before.statuses[idx] };
  if (opts.label !== undefined) updated.label = opts.label;
  if (opts.color !== undefined) updated.color = opts.color;
  if (opts.icon !== undefined) updated.icon = opts.icon;
  if (opts.description !== undefined) updated.description = opts.description;
  if (opts.terminal !== undefined) {
    if (opts.terminal !== 'true' && opts.terminal !== 'false') {
      throw new Error('--terminal must be literally "true" or "false"');
    }
    updated.terminal = opts.terminal === 'true';
  }

  const statuses = [...before.statuses];
  statuses[idx] = updated;
  const after: StatusConfig = {
    statuses,
    order: before.order,
    transitions: before.transitions,
    derive: before.derive ?? null,
    // Preserve custom fact declarations across status mutations — same
    // silent-deletion bug class as derive (Settings/CLI rebuild the block).
    facts: before.facts ?? null,
  };

  if (opts.dryRun) {
    printBlockDiff(before, after);
    return;
  }
  await persistBundle(bundle, after);
}

export async function runStatusReorder(csv: string, opts: { dryRun?: boolean }): Promise<void> {
  const config = await readConfig();
  const bundle = await requireEffectiveBundle(config);
  const before = bundle.block;
  const requested = csv
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const currentIds = new Set(before.order);
  const requestedSet = new Set(requested);
  if (requested.length !== before.order.length || ![...currentIds].every((id) => requestedSet.has(id))) {
    throw new Error(
      `reorder list must be a permutation of the current order: ${before.order.join(', ')}`,
    );
  }
  if (requestedSet.size !== requested.length) {
    throw new Error('reorder list contains duplicate ids');
  }
  const after: StatusConfig = {
    statuses: before.statuses,
    order: requested,
    transitions: before.transitions,
    derive: before.derive ?? null,
    // Preserve custom fact declarations across status mutations — same
    // silent-deletion bug class as derive (Settings/CLI rebuild the block).
    facts: before.facts ?? null,
  };
  if (opts.dryRun) {
    printBlockDiff(before, after);
    return;
  }
  await persistBundle(bundle, after);
}

// ----- remove ---------------------------------------------------------------

function formatAffected(list: AffectedAssignment[]): string {
  return list.map((a) => `  - ${a.display}`).join('\n');
}

export async function runStatusRemove(
  id: string,
  opts: { force?: boolean; dryRun?: boolean },
): Promise<void> {
  const config = await readConfig();
  const bundle = await requireEffectiveBundle(config);
  const before = bundle.block;
  if (!before.statuses.some((s) => s.id === id)) {
    throw new Error(`Status "${id}" does not exist.`);
  }

  const { projectsDir, standaloneDir } = await scanDirs();
  // Rename must reach cached `phase` and history phase keys too, not just the
  // headline — a blocked/pinned assignment can reference the id only there.
  const affected = await scanAssignmentsReferencingStatus(
    projectsDir,
    standaloneDir,
    id,
    scanScope(config, bundle),
  );

  if (affected.length > 0 && !opts.force) {
    throw new Error(
      `${affected.length} assignment(s) still use status "${id}":\n${formatAffected(affected)}\n` +
        `Re-run with --force to remove the status anyway (the affected assignments keep their now-invalid status; ` +
        `\`syntaur doctor\` will flag them).`,
    );
  }

  // --force (or no affected): edit config only. Affected assignment.md files are
  // intentionally left untouched so doctor can flag them — DO NOT delete them.
  const after: StatusConfig = {
    statuses: before.statuses.filter((s) => s.id !== id),
    order: before.order.filter((o) => o !== id),
    transitions: effectiveTransitions(before).filter((t) => t.from !== id && t.to !== id),
    // Derive rules referencing the removed id are preserved as-is — doctor /
    // validateDeriveConfig flags them, mirroring the affected-assignments policy.
    derive: before.derive ?? null,
    // Preserve custom fact declarations across status mutations — same
    // silent-deletion bug class as derive (Settings/CLI rebuild the block).
    facts: before.facts ?? null,
  };

  if (opts.dryRun) {
    printBlockDiff(before, after);
    if (affected.length > 0) {
      console.log(`\n(${affected.length} assignment(s) would be left referencing the removed "${id}".)`);
    }
    return;
  }
  await persistBundle(bundle, after);
}

// ----- rename (atomic across config.md + every affected assignment.md) -------

export async function runStatusRename(
  id: string,
  opts: { to?: string; label?: string; dryRun?: boolean },
): Promise<void> {
  if (!opts.to) throw new Error('--to <new-id> is required');
  const newId = opts.to;
  if (!/^[a-zA-Z0-9_-]+$/.test(newId)) {
    throw new Error(`Invalid new status id "${newId}" — use letters, digits, "_" or "-".`);
  }
  const config = await readConfig();
  const bundle = await requireEffectiveBundle(config);
  const before = bundle.block;
  const target = before.statuses.find((s) => s.id === id);
  if (!target) throw new Error(`Status "${id}" does not exist.`);
  if (before.statuses.some((s) => s.id === newId)) {
    throw new Error(`Status "${newId}" already exists — pick a new id.`);
  }

  const after: StatusConfig = {
    statuses: before.statuses.map((s) =>
      s.id === id ? { ...s, id: newId, label: opts.label ?? s.label } : s,
    ),
    order: before.order.map((o) => (o === id ? newId : o)),
    transitions: effectiveTransitions(before).map((t) => ({
      ...t,
      from: t.from === id ? newId : t.from,
      to: t.to === id ? newId : t.to,
    })),
    // Relabel derive-rule references too (phase ids + headline targets share
    // the status-id namespace; `when` conditions reference facts, not ids).
    derive: before.derive
      ? {
          phaseLadder: before.derive.phaseLadder.map((r) =>
            r.phase === id ? { ...r, phase: newId } : r,
          ),
          disposition: before.derive.disposition,
          headline: {
            ...before.derive.headline,
            parked: before.derive.headline.parked === id ? newId : before.derive.headline.parked,
            blocked: before.derive.headline.blocked === id ? newId : before.derive.headline.blocked,
          },
        }
      : null,
    // Custom fact names are independent of status ids — preserve verbatim.
    facts: before.facts ?? null,
  };

  const { projectsDir, standaloneDir } = await scanDirs();
  // Rename must reach cached `phase` and history phase keys too, not just the
  // headline — a blocked/pinned assignment can reference the id only there.
  const affected = await scanAssignmentsReferencingStatus(
    projectsDir,
    standaloneDir,
    id,
    scanScope(config, bundle),
  );

  if (opts.dryRun) {
    printBlockDiff(before, after);
    const now = nowTimestamp();
    for (const a of affected) {
      const original = await readFile(a.path, 'utf-8');
      const rewritten = renameAssignmentStatusRefs(original, id, newId, now);
      console.log(`\n--- ${a.display}/assignment.md`);
      console.log(`+++ ${a.display}/assignment.md`);
      console.log(lineDiff(original, rewritten));
    }
    return;
  }

  // Atomic transaction: buffer config.md + every affected assignment.md, write all
  // (atomically, via writeFileForce), restore every buffered original on any failure.
  const cfgPath = configPath();
  const buffers = new Map<string, string>();
  buffers.set(cfgPath, (await fileExists(cfgPath)) ? await readFile(cfgPath, 'utf-8') : '');
  for (const a of affected) {
    buffers.set(a.path, await readFile(a.path, 'utf-8'));
  }

  const now = nowTimestamp();
  try {
    await persistBundle(bundle, after);
    for (const a of affected) {
      const original = buffers.get(a.path)!;
      // `status rename` is a relabel, NOT a lifecycle transition: it must not
      // append a statusHistory entry (that would reset `statusAge`). Instead we
      // relabel the id in-place across existing history entries (preserving each
      // `at`), so derived `completedAt` stays correct after renaming a terminal
      // status. See the status-history audit in the Query Language Piece 1 plan.
      const rewritten = renameAssignmentStatusRefs(original, id, newId, now);
      await writeFileForce(a.path, rewritten);
    }
  } catch (err) {
    // Roll back everything we buffered.
    for (const [p, original] of buffers) {
      if (original.length === 0) continue;
      await writeFileForce(p, original).catch(() => {
        /* best-effort rollback */
      });
    }
    throw new Error(
      `rename failed and was rolled back: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// ----- transition add / remove ----------------------------------------------

export interface TransitionAddOptions {
  from?: string;
  command?: string;
  to?: string;
  label?: string;
  requiresReason?: boolean;
  dryRun?: boolean;
}

export async function runStatusTransitionAdd(opts: TransitionAddOptions): Promise<void> {
  if (!opts.from || !opts.command || !opts.to) {
    throw new Error('--from, --command, and --to are all required');
  }
  const config = await readConfig();
  const bundle = await requireEffectiveBundle(config);
  const before = bundle.block;
  const ids = new Set(before.statuses.map((s) => s.id));
  if (!ids.has(opts.from)) throw new Error(`--from "${opts.from}" is not a defined status`);
  if (!ids.has(opts.to)) throw new Error(`--to "${opts.to}" is not a defined status`);
  const base = effectiveTransitions(before);
  if (base.some((t) => t.from === opts.from && t.command === opts.command)) {
    throw new Error(`a transition from "${opts.from}" with command "${opts.command}" already exists`);
  }
  const transition: StatusConfig['transitions'][number] = {
    from: opts.from,
    command: opts.command,
    to: opts.to,
  };
  if (opts.label) transition.label = opts.label;
  if (opts.requiresReason) transition.requiresReason = true;

  const after: StatusConfig = {
    statuses: before.statuses,
    order: before.order,
    transitions: [...base, transition],
    derive: before.derive ?? null,
    // Preserve custom fact declarations across status mutations — same
    // silent-deletion bug class as derive (Settings/CLI rebuild the block).
    facts: before.facts ?? null,
  };
  if (opts.dryRun) {
    printBlockDiff(before, after);
    return;
  }
  await persistBundle(bundle, after);
}

export async function runStatusTransitionRemove(opts: {
  from?: string;
  command?: string;
  dryRun?: boolean;
}): Promise<void> {
  if (!opts.from || !opts.command) throw new Error('--from and --command are required');
  const config = await readConfig();
  const bundle = await requireEffectiveBundle(config);
  const before = bundle.block;
  const base = effectiveTransitions(before);
  const remaining = base.filter((t) => !(t.from === opts.from && t.command === opts.command));
  if (remaining.length === base.length) {
    throw new Error(`no transition from "${opts.from}" with command "${opts.command}" found`);
  }
  const after: StatusConfig = {
    statuses: before.statuses,
    order: before.order,
    transitions: remaining,
    derive: before.derive ?? null,
    // Preserve custom fact declarations across status mutations — same
    // silent-deletion bug class as derive (Settings/CLI rebuild the block).
    facts: before.facts ?? null,
  };
  if (opts.dryRun) {
    printBlockDiff(before, after);
    return;
  }
  await persistBundle(bundle, after);
}

// ----- command wiring -------------------------------------------------------

function printList(result: StatusListResult): void {
  console.log(`Statuses (source: ${result.source}):`);
  const byId = new Map(result.statuses.map((s) => [s.id, s]));
  for (const id of result.order) {
    const s = byId.get(id);
    const label = s?.label ?? id;
    const flags = s?.terminal ? ' (terminal)' : '';
    const color = s?.color ? ` [${s.color}]` : '';
    console.log(`  ${id}  —  ${label}${color}${flags}`);
  }
  if (result.transitions.length > 0) {
    console.log(`Transitions: ${result.transitions.length}`);
    for (const t of result.transitions) {
      console.log(`  ${t.from} --${t.command}--> ${t.to}`);
    }
  }
}

export const statusCommand = new Command('status').description(
  'Manage assignment statuses + transitions (the statuses: block in ~/.syntaur/config.md)',
);

statusCommand
  .command('list')
  .description('List the current statuses, order, and transitions')
  .option('--json', 'Output as JSON')
  .action(async (opts: { json?: boolean }) => {
    try {
      const result = await runStatusList();
      if (opts.json) console.log(JSON.stringify(result, null, 2));
      else printList(result);
    } catch (error) {
      fail(error);
    }
  });

statusCommand
  .command('init')
  .description('Materialize the built-in default statuses into config.md')
  .option('--force', 'Overwrite an existing custom statuses block')
  .option('--dry-run', 'Print the diff without writing')
  .action(async (opts: { force?: boolean; dryRun?: boolean }) => {
    try {
      await runStatusInit(opts);
      if (!opts.dryRun) console.log('Initialized default statuses in config.md.');
    } catch (error) {
      fail(error);
    }
  });

statusCommand
  .command('reset')
  .description('Remove the statuses block and revert to implicit defaults')
  .option('--force', 'Skip the destructive-change guard (no-op in non-interactive CLI)')
  .option('--dry-run', 'Print the diff without writing')
  .action(async (opts: { dryRun?: boolean }) => {
    try {
      await runStatusReset(opts);
      if (!opts.dryRun) console.log('Reset statuses to implicit defaults.');
    } catch (error) {
      fail(error);
    }
  });

statusCommand
  .command('add')
  .description('Append a new status')
  .argument('<id>', 'Status id (letters, digits, "_" or "-")')
  .requiredOption('--label <label>', 'Human-readable label')
  .option('--color <hex-or-name>', 'Accent color')
  .option('--icon <name>', 'Icon name')
  .option('--description <text>', 'Description')
  .option('--terminal', 'Mark this status as terminal (counts as "done")')
  .option('--after <id>', 'Insert immediately after this status id')
  .option('--before <id>', 'Insert immediately before this status id')
  .option('--at-end', 'Append at the end of the order (default)')
  .option('--dry-run', 'Print the diff without writing')
  .action(async (id: string, opts: StatusAddOptions) => {
    try {
      await runStatusAdd(id, opts);
      if (!opts.dryRun) console.log(`Added status "${id}".`);
    } catch (error) {
      fail(error);
    }
  });

statusCommand
  .command('set')
  .description('Edit metadata on an existing status (without renaming its id)')
  .requiredOption('--id <id>', 'Status id to edit')
  .option('--label <label>', 'New label')
  .option('--color <hex-or-name>', 'New color')
  .option('--icon <name>', 'New icon')
  .option('--description <text>', 'New description')
  .option('--terminal <true|false>', 'Set terminal flag (literal true/false)')
  .option('--dry-run', 'Print the diff without writing')
  .action(async (opts: StatusSetOptions) => {
    try {
      await runStatusSet(opts);
      if (!opts.dryRun) console.log(`Updated status "${opts.id}".`);
    } catch (error) {
      fail(error);
    }
  });

statusCommand
  .command('reorder')
  .description('Replace the status order (CSV must be a permutation of current ids)')
  .argument('<ids>', 'Comma-separated status ids in the new order (e.g. draft,pending,review)')
  .option('--dry-run', 'Print the diff without writing')
  .action(async (csv: string, opts: { dryRun?: boolean }) => {
    try {
      await runStatusReorder(csv, opts);
      if (!opts.dryRun) console.log('Reordered statuses.');
    } catch (error) {
      fail(error);
    }
  });

statusCommand
  .command('remove')
  .description('Remove a status (config-only; affected assignments keep their status)')
  .argument('<id>', 'Status id to remove')
  .option('--force', 'Remove even when assignments still reference the status')
  .option('--dry-run', 'Print the diff without writing')
  .action(async (id: string, opts: { force?: boolean; dryRun?: boolean }) => {
    try {
      await runStatusRemove(id, opts);
      if (!opts.dryRun) console.log(`Removed status "${id}".`);
    } catch (error) {
      fail(error);
    }
  });

statusCommand
  .command('rename')
  .description('Rename a status id atomically across config.md + every affected assignment.md')
  .argument('<id>', 'Existing status id')
  .requiredOption('--to <new-id>', 'New status id')
  .option('--label <label>', 'New label (default: keep the original)')
  .option('--dry-run', 'Print the per-file diffs without writing')
  .action(async (id: string, opts: { to?: string; label?: string; dryRun?: boolean }) => {
    try {
      await runStatusRename(id, opts);
      if (!opts.dryRun) console.log(`Renamed status "${id}" → "${opts.to}".`);
    } catch (error) {
      fail(error);
    }
  });

const transitionCommand = statusCommand
  .command('transition')
  .description('Manage custom status transitions');

transitionCommand
  .command('add')
  .description('Define a custom transition')
  .requiredOption('--from <id>', 'Source status id')
  .requiredOption('--command <cmd>', 'Transition command name')
  .requiredOption('--to <id>', 'Target status id')
  .option('--label <label>', 'Button label')
  .option('--requires-reason', 'Require a reason when invoking this transition')
  .option('--dry-run', 'Print the diff without writing')
  .action(async (opts: TransitionAddOptions) => {
    try {
      await runStatusTransitionAdd(opts);
      if (!opts.dryRun) console.log(`Added transition ${opts.from} --${opts.command}--> ${opts.to}.`);
    } catch (error) {
      fail(error);
    }
  });

transitionCommand
  .command('remove')
  .description('Drop a custom transition')
  .requiredOption('--from <id>', 'Source status id')
  .requiredOption('--command <cmd>', 'Transition command name')
  .option('--dry-run', 'Print the diff without writing')
  .action(async (opts: { from?: string; command?: string; dryRun?: boolean }) => {
    try {
      await runStatusTransitionRemove(opts);
      if (!opts.dryRun) console.log(`Removed transition ${opts.from} --${opts.command}-->.`);
    } catch (error) {
      fail(error);
    }
  });

// ── derived-status pin/unpin (design v3, Piece 4) ───────────────────────────
import { statusPinCommand, statusUnpinCommand } from './derive-verbs.js';

statusCommand
  .command('pin')
  .description('Pin (override) an assignment to a status — sticky until unpinned; non-terminal only')
  .argument('<assignment>', 'Assignment slug or standalone UUID')
  .argument('<status>', 'Status id to pin to (terminal statuses refused)')
  .option('--project <slug>', 'Target project slug')
  .option('--reason <text>', 'Why the pin is needed (recorded in history)')
  .option('--agent <name>', 'Acting agent id (default: bound session, else human)')
  .option('--dir <path>', 'Override default project directory')
  .action(async (assignment, status, opts) => {
    try {
      await statusPinCommand(assignment, status, opts);
    } catch (error) {
      fail(error);
    }
  });

statusCommand
  .command('unpin')
  .description('Clear a status pin — status re-derives from facts')
  .argument('<assignment>', 'Assignment slug or standalone UUID')
  .option('--project <slug>', 'Target project slug')
  .option('--agent <name>', 'Acting agent id')
  .option('--dir <path>', 'Override default project directory')
  .action(async (assignment, opts) => {
    try {
      await statusUnpinCommand(assignment, opts);
    } catch (error) {
      fail(error);
    }
  });
