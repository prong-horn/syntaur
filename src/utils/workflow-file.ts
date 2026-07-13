/**
 * Parse / serialize a per-file workflow (`~/.syntaur/workflows/<id>.md`, yaml) to
 * and from the browser-safe {@link StageWorkflow} model (Phase 1 stage engine,
 * WS-0). Uses the `yaml` package's safe-by-default `parse`/`stringify` — the
 * deliberate, confined dependency the nested stage model needs (design §4.6),
 * NOT the hand-rolled `config.md` frontmatter parser.
 *
 * **Loose, no-throw contract** (mirrors `parseStatusConfig` at config.ts:667): a
 * malformed field is preserved (on a typed field or the struct's `raw`
 * passthrough) and surfaced in `issues` — never thrown on and never dropped. The
 * one exception is a yaml *syntax* error, which prevents any structured read; it
 * is caught and reported as an issue with an empty workflow.
 *
 * On-disk key convention (design §2.2): stages use `on-dissent`, the workflow
 * uses `terminal_failure`; both map to camelCase TS fields here and back.
 *
 * "Round-trips losslessly" means DATA-lossless: `parse(serialize(parse(x)))`
 * deep-equals `parse(x)`. yaml block/flow style is not preserved (nor should it
 * be) — the workflow object is the source of truth.
 */

import { join } from 'node:path';
import { parse as yamlParse, stringify as yamlStringify } from 'yaml';
import { workflowsDir } from './paths.js';
import {
  ROUTE_TRIGGERS,
  type StageWorkflow,
  type WorkflowStage,
  type StageCheck,
  type StageRoute,
  type StageWork,
  type WorkflowFlags,
  type WorkflowFlag,
  type RouteTrigger,
} from './stage-model.js';

/**
 * Workflow ids must be keyword-safe slugs so they round-trip through config.md
 * and stay confined to a single `<id>.md` file. This is a SECURITY boundary: it
 * rejects path separators / `..` (which would let a crafted id escape the
 * workflows dir, e.g. `../config` → `~/.syntaur/config.md`) and newlines (which
 * would let an id inject a top-level frontmatter block via the default-pointer
 * scalar). Shared with the legacy CLI create/delete path.
 */
export function isValidWorkflowId(id: string): boolean {
  return /^[a-z0-9][a-z0-9_-]*$/i.test(id) && id.length <= 64;
}

/**
 * Absolute path to a workflow's per-file store: `~/.syntaur/workflows/<id>.md`.
 * Throws on an invalid id so every write stays confined to the workflows dir.
 */
export function workflowFilePath(id: string): string {
  if (!isValidWorkflowId(id)) {
    throw new Error(
      `invalid workflow id "${id}" (must match /^[a-z0-9][a-z0-9_-]*$/, ≤64 chars)`,
    );
  }
  return join(workflowsDir(), `${id}.md`);
}

// --- parse helpers -------------------------------------------------------

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Read `obj[key]` as a string. A non-string value is PRESERVED verbatim on the
 * `raw` bag (so it round-trips) and flagged — never `String()`-coerced into a
 * lossy `"[object Object]"` / comma-joined value. Upholds the no-silent-deletion
 * / data-lossless contract for every string field uniformly.
 */
function str(
  obj: Record<string, unknown>,
  key: string,
  raw: Record<string, unknown>,
  issues: string[],
  ctx: string,
): string | undefined {
  const v = obj[key];
  if (v === undefined) return undefined;
  if (typeof v === 'string') return v;
  issues.push(`${ctx}.${key} must be a string`);
  raw[key] = v;
  return undefined;
}

/** Collect every key NOT in `known` into a `raw` bag (no silent deletion). */
function collectUnknown(
  obj: Record<string, unknown>,
  known: readonly string[],
): Record<string, unknown> | undefined {
  const raw: Record<string, unknown> = {};
  let has = false;
  for (const k of Object.keys(obj)) {
    if (!known.includes(k)) {
      raw[k] = obj[k];
      has = true;
    }
  }
  return has ? raw : undefined;
}

const CHECK_KEYS = ['check', 'not', 'by', 'judge', 'binds', 'quorum', 'condition'] as const;

function parseCheck(entry: unknown, issues: string[], ctx: string): StageCheck {
  if (!isObject(entry)) {
    issues.push(`${ctx} must be a mapping`);
    return { check: '', raw: { __malformed: entry } };
  }
  const raw = collectUnknown(entry, CHECK_KEYS) ?? {};
  const check: StageCheck = { check: str(entry, 'check', raw, issues, ctx) ?? '' };
  const not = str(entry, 'not', raw, issues, ctx);
  if (not !== undefined) check.not = not;
  const by = str(entry, 'by', raw, issues, ctx);
  if (by !== undefined) check.by = by;
  const judge = str(entry, 'judge', raw, issues, ctx);
  if (judge !== undefined) check.judge = judge;
  const binds = str(entry, 'binds', raw, issues, ctx);
  if (binds !== undefined) check.binds = binds;
  if (entry.quorum !== undefined) {
    if (typeof entry.quorum === 'number') check.quorum = entry.quorum;
    else {
      issues.push(`${ctx}.quorum must be a number`);
      raw.quorum = entry.quorum; // preserved, not coerced through NaN→0
    }
  }
  const condition = str(entry, 'condition', raw, issues, ctx);
  if (condition !== undefined) check.condition = condition;
  // A `not:`-only entry (the design's `- not: <check>ChangesRequested` rework
  // hold) is a valid standalone predicate — the malformed case is having NO
  // predicate at all (neither `check`, `condition`, nor `not`).
  if (entry.check === undefined && entry.condition === undefined && entry.not === undefined) {
    issues.push(`${ctx} has no predicate (needs a 'check', 'condition', or 'not')`);
  }
  if (Object.keys(raw).length > 0) check.raw = raw;
  return check;
}

function parseRoute(entry: unknown, issues: string[], ctx: string): StageRoute {
  if (typeof entry === 'string') return { to: entry }; // shorthand: `- implementing`
  if (!isObject(entry)) {
    issues.push(`${ctx} must be a mapping or a string`);
    return { to: '', raw: { __malformed: entry } };
  }
  const raw = collectUnknown(entry, ['to', 'on']) ?? {};
  const route: StageRoute = { to: str(entry, 'to', raw, issues, ctx) ?? '' };
  if (entry.to === undefined) issues.push(`${ctx} is missing 'to'`);
  if (entry.on !== undefined) {
    const on = entry.on;
    if (typeof on === 'string' && (ROUTE_TRIGGERS as readonly string[]).includes(on)) {
      route.on = on as RouteTrigger;
    } else {
      // Preserve the original value verbatim rather than casting a bogus string
      // (or coercing a non-string) into a RouteTrigger.
      issues.push(`${ctx}.on "${String(on)}" is not one of ${ROUTE_TRIGGERS.join('|')}`);
      raw.on = on;
    }
  }
  if (Object.keys(raw).length > 0) route.raw = raw;
  return route;
}

function parseWork(entry: unknown, issues: string[], ctx: string): StageWork {
  if (!isObject(entry)) {
    issues.push(`${ctx} must be a mapping`);
    return { raw: { __malformed: entry } };
  }
  const raw = collectUnknown(entry, ['agent', 'playbooks', 'launchPrompt']) ?? {};
  const work: StageWork = {};
  const agent = str(entry, 'agent', raw, issues, ctx);
  if (agent !== undefined) work.agent = agent;
  if (entry.playbooks !== undefined) {
    if (Array.isArray(entry.playbooks) && entry.playbooks.every((p) => typeof p === 'string')) {
      work.playbooks = entry.playbooks as string[];
    } else {
      // Preserve verbatim rather than String()-coercing non-strings into
      // "[object Object]" (silent corruption) — the no-silent-deletion contract.
      issues.push(`${ctx}.playbooks must be a list of strings`);
      raw.playbooks = entry.playbooks;
    }
  }
  const launchPrompt = str(entry, 'launchPrompt', raw, issues, ctx);
  if (launchPrompt !== undefined) work.launchPrompt = launchPrompt;
  if (Object.keys(raw).length > 0) work.raw = raw;
  return work;
}

const STAGE_KEYS = [
  'id',
  'label',
  'color',
  'guidance',
  'work',
  'deliverable',
  'gate',
  'next',
  'on-dissent',
  'terminal',
  'reopen',
] as const;

function parseStage(entry: unknown, issues: string[], index: number): WorkflowStage {
  const ctx = `stages[${index}]`;
  if (!isObject(entry)) {
    issues.push(`${ctx} must be a mapping`);
    return { id: '', raw: { __malformed: entry } };
  }
  const raw = collectUnknown(entry, STAGE_KEYS) ?? {};
  const stage: WorkflowStage = { id: str(entry, 'id', raw, issues, ctx) ?? '' };
  if (entry.id === undefined) issues.push(`${ctx} is missing 'id'`);
  const label = str(entry, 'label', raw, issues, ctx);
  if (label !== undefined) stage.label = label;
  const color = str(entry, 'color', raw, issues, ctx);
  if (color !== undefined) stage.color = color;
  const guidance = str(entry, 'guidance', raw, issues, ctx);
  if (guidance !== undefined) stage.guidance = guidance;
  if (entry.work !== undefined) stage.work = parseWork(entry.work, issues, `${ctx}.work`);
  const deliverable = str(entry, 'deliverable', raw, issues, ctx);
  if (deliverable !== undefined) stage.deliverable = deliverable;
  if (entry.gate !== undefined) {
    if (Array.isArray(entry.gate)) {
      stage.gate = entry.gate.map((g, i) => parseCheck(g, issues, `${ctx}.gate[${i}]`));
    } else {
      issues.push(`${ctx}.gate must be a list`);
      raw.gate = entry.gate;
    }
  }
  if (entry.next !== undefined) {
    if (Array.isArray(entry.next)) {
      stage.next = entry.next.map((r, i) => parseRoute(r, issues, `${ctx}.next[${i}]`));
    } else {
      issues.push(`${ctx}.next must be a list`);
      raw.next = entry.next;
    }
  }
  const onDissent = str(entry, 'on-dissent', raw, issues, ctx);
  if (onDissent !== undefined) stage.onDissent = onDissent;
  if (entry.terminal !== undefined) {
    if (typeof entry.terminal === 'boolean') stage.terminal = entry.terminal;
    else {
      // Do NOT Boolean()-coerce: `terminal: "false"` would become `true`,
      // inverting meaning AND fooling the no-terminal doctor check. Preserve the
      // raw value and leave `terminal` unset so it is not read as a real flag.
      issues.push(`${ctx}.terminal must be a boolean`);
      raw.terminal = entry.terminal;
    }
  }
  const reopen = str(entry, 'reopen', raw, issues, ctx);
  if (reopen !== undefined) stage.reopen = reopen;
  if (Object.keys(raw).length > 0) stage.raw = raw;
  return stage;
}

function parseFlag(entry: unknown, issues: string[], ctx: string): WorkflowFlag {
  if (entry === null || entry === undefined) return {}; // `hold:` with no value
  if (!isObject(entry)) {
    issues.push(`${ctx} must be a mapping`);
    return { raw: { __malformed: entry } };
  }
  const raw = collectUnknown(entry, ['when']) ?? {};
  const flag: WorkflowFlag = {};
  const when = str(entry, 'when', raw, issues, ctx);
  if (when !== undefined) flag.when = when;
  if (Object.keys(raw).length > 0) flag.raw = raw;
  return flag;
}

function parseFlags(entry: unknown, issues: string[]): WorkflowFlags {
  if (!isObject(entry)) {
    issues.push(`flags must be a mapping`);
    return {};
  }
  const flags: WorkflowFlags = {};
  for (const [name, def] of Object.entries(entry)) {
    flags[name] = parseFlag(def, issues, `flags.${name}`);
  }
  return flags;
}

const WORKFLOW_KEYS = ['id', 'label', 'stages', 'flags', 'terminal_failure', 'workspace'] as const;

/**
 * Parse a per-file workflow's yaml into a {@link StageWorkflow}, collecting every
 * structural problem in `issues` without throwing or dropping content.
 */
export function parseWorkflowFile(raw: string): { workflow: StageWorkflow; issues: string[] } {
  const issues: string[] = [];
  let doc: unknown;
  try {
    doc = yamlParse(raw);
  } catch (err) {
    issues.push(`yaml parse error: ${err instanceof Error ? err.message : String(err)}`);
    return { workflow: { id: '', stages: [] }, issues };
  }
  if (doc === undefined || doc === null) {
    issues.push('workflow file is empty');
    return { workflow: { id: '', stages: [] }, issues };
  }
  if (!isObject(doc)) {
    issues.push('workflow file must be a yaml mapping');
    return { workflow: { id: '', stages: [] }, issues };
  }

  const rawTop = collectUnknown(doc, WORKFLOW_KEYS) ?? {};
  const workflow: StageWorkflow = {
    id: str(doc, 'id', rawTop, issues, 'workflow') ?? '',
    stages: [],
  };
  if (doc.id === undefined) issues.push(`workflow is missing 'id'`);
  const label = str(doc, 'label', rawTop, issues, 'workflow');
  if (label !== undefined) workflow.label = label;
  if (doc.stages === undefined) {
    issues.push(`workflow is missing 'stages'`);
  } else if (Array.isArray(doc.stages)) {
    workflow.stages = doc.stages.map((s, i) => parseStage(s, issues, i));
  } else {
    issues.push(`'stages' must be a list`);
    rawTop.stages = doc.stages;
  }
  if (doc.flags !== undefined) {
    if (isObject(doc.flags)) {
      workflow.flags = parseFlags(doc.flags, issues);
    } else {
      // A non-mapping `flags:` (e.g. a list) is preserved on `raw`, not dropped.
      issues.push('flags must be a mapping');
      rawTop.flags = doc.flags;
    }
  }
  const tf = str(doc, 'terminal_failure', rawTop, issues, 'workflow');
  if (tf !== undefined) workflow.terminalFailure = tf;
  if (doc.workspace !== undefined) {
    if (doc.workspace === 'git' || doc.workspace === 'none') workflow.workspace = doc.workspace;
    else {
      issues.push(`workspace must be 'git' or 'none'`);
      rawTop.workspace = doc.workspace;
    }
  }
  if (Object.keys(rawTop).length > 0) workflow.raw = rawTop;
  return { workflow, issues };
}

// --- serialize helpers ---------------------------------------------------

/** Drop `undefined` values and, if the object is otherwise empty, still keep it
 * (an empty flag `hold: {}` must serialize as `{}`, not vanish). */
function compact(o: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) out[k] = v;
  return out;
}

function serializeCheck(c: StageCheck): Record<string, unknown> {
  const o = compact({
    // Drop an empty `check` so a `not:`-only entry round-trips as `{ not: … }`,
    // not `{ check: '', not: … }` (which would fool the no-predicate guard).
    check: c.check || undefined,
    not: c.not,
    by: c.by,
    judge: c.judge,
    binds: c.binds,
    quorum: c.quorum,
    condition: c.condition,
  });
  if (c.raw) Object.assign(o, c.raw);
  return o;
}

function serializeRoute(r: StageRoute): Record<string, unknown> {
  const o = compact({ to: r.to, on: r.on });
  if (r.raw) Object.assign(o, r.raw);
  return o;
}

function serializeWork(w: StageWork): Record<string, unknown> {
  const o = compact({ agent: w.agent, playbooks: w.playbooks, launchPrompt: w.launchPrompt });
  if (w.raw) Object.assign(o, w.raw);
  return o;
}

function serializeStage(s: WorkflowStage): Record<string, unknown> {
  const o = compact({
    id: s.id,
    label: s.label,
    color: s.color,
    guidance: s.guidance,
    work: s.work ? serializeWork(s.work) : undefined,
    deliverable: s.deliverable,
    gate: s.gate ? s.gate.map(serializeCheck) : undefined,
    next: s.next ? s.next.map(serializeRoute) : undefined,
    'on-dissent': s.onDissent,
    terminal: s.terminal,
    reopen: s.reopen,
  });
  if (s.raw) Object.assign(o, s.raw);
  return o;
}

function serializeFlags(flags: WorkflowFlags): Record<string, unknown> {
  const o: Record<string, unknown> = {};
  for (const [name, def] of Object.entries(flags)) {
    if (def === undefined) continue;
    const f = compact({ when: def.when });
    if (def.raw) Object.assign(f, def.raw);
    o[name] = f;
  }
  return o;
}

/** Serialize a {@link StageWorkflow} to yaml with a stable key order. */
export function serializeWorkflowFile(wf: StageWorkflow): string {
  const o = compact({
    id: wf.id,
    label: wf.label,
    stages: wf.stages.map(serializeStage),
    flags: wf.flags ? serializeFlags(wf.flags) : undefined,
    terminal_failure: wf.terminalFailure,
    workspace: wf.workspace,
  });
  if (wf.raw) Object.assign(o, wf.raw);
  return yamlStringify(o);
}
