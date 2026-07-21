/**
 * The pure stage engine (Phase 1 stage engine, WS-1): `facts + workflow → moves`.
 *
 * The successor to `deriveDimensions`' memoryless ladder. Instead of re-ranking a
 * ticket's absolute position from facts on every change, the engine advances a
 * ticket's STORED position (`status:`) along DECLARED routes whose GATES are
 * observable checks. It is the ONLY mover-logic source — WS-2 (integration),
 * the Phase-2 simulator, and WS-3's migration divergence report all reuse it.
 *
 * **Pure by construction.** Like `derive.ts` (which this sits beside and which is
 * `@shared/derive`-aliased into the dashboard bundle), this module imports no Node
 * builtin and no Node-only module — only the browser-safe AQL evaluator
 * (`src/utils/query`, verified Node-free), `DERIVE_FIELDS`, and type-only shapes.
 * A purity-guard test enforces it. All fs-bound facts (attestation validity,
 * solicitation currentness, git HEAD) are computed Node-side and passed IN — the
 * engine never reads disk. See the assignment decision record (Decisions 1, 5).
 *
 * @see design authority §2.2–2.6 (routes, gates, the four check states, regression,
 *      placement) and parent-plan decisions #7 (judged gates: evaluate, don't
 *      identity-enforce) and #8 (minimal solicitation substrate).
 */

import {
  parseQuery,
  compileNode,
  CompileError,
  type Predicate,
  type FieldRegistry,
} from '../utils/query/index.js';
import { DERIVE_FIELDS } from '../utils/fact-registry.js';
import type { StageWorkflow, WorkflowStage, StageCheck, StageRoute } from '../utils/stage-model.js';
import type { AssignmentFacts } from './derive.js';
import type { AttestationRecord, Solicitation } from './types.js';

// ── Public types ─────────────────────────────────────────────────────────────

/** The four check states (design §2.5): computed checks use only pass/fail. */
export type CheckState = 'pass' | 'fail' | 'awaiting' | 'stale';

/**
 * One judged check's evidence, pre-evaluated Node-side (the engine is pure).
 * `valid`/`current` mirror `facts.ts` `isAttestationValid` + the solicitation
 * currentness check WS-2 supplies — the engine never reads a revision.
 */
export interface CheckEvidence {
  records: ReadonlyArray<{ record: AttestationRecord; valid: boolean }>;
  solicitations: ReadonlyArray<{ solicitation: Solicitation; current: boolean }>;
}

/** Everything the engine needs to evaluate a stage — all passed in, no fs. */
export interface EngineInput {
  /** Computed fact bag (built-ins + custom + attestation exports). */
  facts: AssignmentFacts;
  /** Judged-check evidence, keyed by check name; absent → no attestation/solicitation. */
  evidence: Readonly<Record<string, CheckEvidence>>;
  /** `dissentKey()`s already routed on — edge-trigger bookkeeping (WS-2 persists). */
  firedDissents: ReadonlySet<string>;
  /** The per-ticket manual `hold` flag (design §2.6) — suspends auto movement.
   *  WS-2 supplies it from frontmatter; `blocked`/`parked` come from `facts`. */
  held?: boolean;
  /** AQL field registry for raw `condition:` compilation; default `DERIVE_FIELDS`. */
  registry?: FieldRegistry;
}

/** One evaluated gate entry — the ticket page's live checklist row (✓/✗/⏳/↻). */
export interface EvaluatedCheck {
  /** Stable positional id `${stageId}:${index}` (a bare check name collides for
   *  condition/not-only/duplicate entries — all serialize `check:""`). */
  key: string;
  /** Human id: the check name, the condition expr, or `not <name>`. */
  label: string;
  /** The source gate entry (renders the `by:`/`judge:`/`quorum:` qualifiers). */
  check: StageCheck;
  kind: 'computed' | 'judged';
  state: CheckState;
  /** `state === 'pass'` — the only state that contributes to gate passage. */
  passed: boolean;
  /** Surfaced problem (unknown bare check, malformed condition, misused fact
   *  type) — the honest failure mode, never a silent `false`. */
  issue?: string;
}

/** Whole-gate evaluation: the per-check rows + the AND of their `passed`. */
export interface GateEvaluation {
  checks: EvaluatedCheck[];
  passed: boolean;
}

/** A compact per-entry gate-passage snapshot (for regression + history). */
export interface GateSnapshotEntry {
  key: string;
  label: string;
  passed: boolean;
  /** A `--force`/skip passage never actually passed → excluded from regression. */
  overridden?: boolean;
  /** The check's OWN stage id — set by {@link crossedGates} so a multi-stage
   * override stamps each gate against the stage it belongs to, not the move
   * source, and so its self-clear re-evaluates that stage (codex review 2+3). */
  stage?: string;
}

/**
 * The trigger kind recorded on a hop (design §2.3 "Every move appends").
 *
 * `advance`/`evaluateRoutes` PRODUCE only the first six (gate/work-start/manual/
 * verdict/placement/regression). `manual-override` and `reopen` are constructed
 * Node-side by WS-2 as the FORCED first move of a `recomputeAndWrite` engine
 * step (a drag past a failing gate, or a reopen re-placement); they never come
 * out of a pure `Hop`, so no engine producer switch handles them — but any
 * CONSUMER that switches over `HopTrigger` (history serializer, dashboard hop
 * rendering) must include the two new arms.
 */
export type HopTrigger =
  | 'gate'
  | 'work-start'
  | 'manual'
  | 'verdict'
  | 'placement'
  | 'regression'
  | 'manual-override'
  | 'reopen';

/** The (check, actor, verdict, binding) that fired a verdict route. */
export interface DissentCause {
  key: string;
  check: string;
  actor: string;
  verdict: 'changes-requested';
  note?: string;
  binding?: string;
}

/** One traversal in a cascade — route + trigger + gate snapshot (+ dissent cause). */
export interface Hop {
  from: string;
  to: string;
  route: StageRoute;
  trigger: HopTrigger;
  snapshot: GateSnapshotEntry[];
  dissent?: DissentCause;
}

/** The result of an auto-cascade `advance`. */
export interface AdvanceResult {
  path: Hop[];
  final: string;
  /** Hit the hop cap (= stage count) — an ill-formed `on: gate` cycle. */
  capped: boolean;
  /** Dissent keys newly fired THIS call — WS-2 persists them (edge-trigger). */
  firedDissents: string[];
}

/** A check that admitted the ticket and has since gone false (design §2.3). */
export interface RegressionFinding {
  stage: string;
  key: string;
  label: string;
  /** WS-1 emits only `flag`; auto-return awaits an explicit per-check policy field. */
  policy: 'flag';
}

/** A detected `on: gate` route cycle, with severity (design §2.3). */
export interface CycleDiagnostic {
  /** `error` = a stage in the cycle has an empty gate (guaranteed livelock);
   *  `warning` = a guarded cycle whose gates may be simultaneously satisfiable
   *  (full AQL SAT is out of scope — the hop cap is the runtime guarantee). */
  severity: 'error' | 'warning';
  path: string[];
  reason: string;
}

const EMPTY_EVIDENCE: CheckEvidence = { records: [], solicitations: [] };
const PLAIN_IDENTIFIER = /^[A-Za-z_]\w*$/;

// ── Raw-condition compilation (mirrors derive.ts:111-131, but no-throw) ───────

const conditionCache = new WeakMap<FieldRegistry, Map<string, Predicate | { error: string }>>();

/** Compile a raw AQL expression against the registry, caching per registry.
 *  Returns `{ error }` instead of throwing (checks never crash the engine). */
function compileCondition(expr: string, registry: FieldRegistry): Predicate | { error: string } {
  let cache = conditionCache.get(registry);
  if (!cache) {
    cache = new Map();
    conditionCache.set(registry, cache);
  }
  let entry = cache.get(expr);
  if (entry === undefined) {
    const parsed = parseQuery(expr);
    if (!parsed.ast) {
      const msg = (parsed.errors ?? []).map((e) => e.message ?? String(e)).join('; ');
      entry = { error: msg || `could not parse condition "${expr}"` };
    } else {
      try {
        entry = compileNode(parsed.ast, registry);
      } catch (e) {
        entry = { error: e instanceof CompileError ? e.message : String(e) };
      }
    }
    cache.set(expr, entry);
  }
  return entry;
}

/** Read a fact as a boolean; a present number/`string[]` fact used as a bare
 *  check is coerced but flagged (the author should write a `condition`). */
function truthyFact(facts: AssignmentFacts, name: string): { value: boolean; issue?: string } {
  const v = (facts as Record<string, unknown>)[name];
  if (typeof v === 'boolean') return { value: v };
  return {
    value: Boolean(v),
    issue: `check "${name}" is not a boolean fact (write it as a condition, e.g. \`${name} > 0\`)`,
  };
}

// ── Check evaluation ─────────────────────────────────────────────────────────

/**
 * The pure four-state function for a JUDGED check (design §2.5, decision #7):
 * evaluate against pre-evaluated attestation validity + solicitation currentness,
 * WITHOUT identity enforcement. Any valid current-revision approval satisfies the
 * check (quorum threshold is 1 in Phase 1 — `by:`/`judge:`/`quorum:` are advisory
 * until Phase 3); any valid dissent vetoes.
 */
export function evaluateCheckState(_check: StageCheck, evidence: CheckEvidence): CheckState {
  const valid = evidence.records.filter((r) => r.valid).map((r) => r.record);
  const validChanges = valid.filter((r) => r.verdict === 'changes-requested');
  if (validChanges.length > 0) return 'fail'; // any valid dissent vetoes (§2.5)

  const validApproved = valid.filter((r) => r.verdict === 'approved');
  if (validApproved.length >= 1) return 'pass'; // quorum=1 in Phase 1 (Decision 3 / #7)

  const openSolicitation = evidence.solicitations.some(
    (s) => s.current && s.solicitation.state === 'solicited',
  );
  if (openSolicitation) return 'awaiting'; // ⏳ judgment solicited, not yet rendered

  const staleApproval = evidence.records.some(
    (r) => !r.valid && r.record.verdict === 'approved',
  );
  if (staleApproval) return 'stale'; // ↻ approved, work moved on

  return 'awaiting'; // unrendered judged check holds (never auto-pass — #7)
}

/** True iff the check declares a judgment (or has judged evidence for it). */
function isJudged(check: StageCheck, input: EngineInput): boolean {
  return (
    check.by !== undefined ||
    check.judge !== undefined ||
    check.quorum !== undefined ||
    (check.check !== '' && input.evidence[check.check] !== undefined)
  );
}

/**
 * Evaluate one gate entry into an {@link EvaluatedCheck}. Dispatch order matters:
 * judged → verdict-export hold (`not:`) → raw expression → bare fact lookup.
 */
export function evaluateCheck(
  check: StageCheck,
  stageId: string,
  index: number,
  input: EngineInput,
): EvaluatedCheck {
  const key = `${stageId}:${index}`;
  const registry = input.registry ?? DERIVE_FIELDS;
  const base = { key, check };

  // 1) Judged check — the four-state resolution.
  if (isJudged(check, input)) {
    const state = evaluateCheckState(check, input.evidence[check.check] ?? EMPTY_EVIDENCE);
    return { ...base, label: check.check, kind: 'judged', state, passed: state === 'pass' };
  }

  // 2) Verdict-export hold — `not: <name>ChangesRequested` holds while it stands.
  if (check.not !== undefined) {
    const present = (input.facts as Record<string, unknown>)[check.not];
    const passed = !present;
    const issue =
      !(check.not in (input.facts as object)) && present === undefined
        ? `not-condition "${check.not}" is not a known fact`
        : undefined;
    return {
      ...base,
      label: `not ${check.not}`,
      kind: 'computed',
      state: passed ? 'pass' : 'fail',
      passed,
      issue,
    };
  }

  // 3) Raw expression — an explicit `condition:`, or a `check` that isn't a plain
  //    identifier (`acRealTotal > 0`, `planApproved:true`, parenthesized, …).
  const expr =
    check.condition !== undefined
      ? check.condition
      : check.check !== '' && !PLAIN_IDENTIFIER.test(check.check)
        ? check.check
        : null;
  if (expr !== null) {
    const compiled = compileCondition(expr, registry);
    if ('error' in compiled) {
      return { ...base, label: expr, kind: 'computed', state: 'fail', passed: false, issue: compiled.error };
    }
    const passed = compiled(input.facts as unknown as Record<string, unknown>, { now: 0 });
    return { ...base, label: expr, kind: 'computed', state: passed ? 'pass' : 'fail', passed };
  }

  // 4) Bare computed fact — a plain identifier resolved by facts-bag lookup.
  //    NEVER AQL-compiled: a lone identifier throws in the AQL grammar
  //    (`atom := IDENT (COLON valueOrList | OP value)`).
  const name = check.check;
  if (!(name in (input.facts as object))) {
    return { ...base, label: name || '(empty)', kind: 'computed', state: 'fail', passed: false, issue: `unknown check "${name}"` };
  }
  const { value, issue } = truthyFact(input.facts, name);
  return { ...base, label: name, kind: 'computed', state: value ? 'pass' : 'fail', passed: value, issue };
}

/** Evaluate a whole gate — the per-check rows + the AND of their `passed`. */
export function evaluateGate(stage: WorkflowStage, input: EngineInput): GateEvaluation {
  const checks = (stage.gate ?? []).map((g, i) => evaluateCheck(g, stage.id, i, input));
  return { checks, passed: checks.every((c) => c.passed) };
}

/** The compact gate snapshot for a stage (positional keys, collision-free). */
function snapshot(stage: WorkflowStage, input: EngineInput): GateSnapshotEntry[] {
  return evaluateGate(stage, input).checks.map((c) => ({ key: c.key, label: c.label, passed: c.passed }));
}

// ── Routes, placement, cascade ───────────────────────────────────────────────

function stageById(workflow: StageWorkflow, id: string): WorkflowStage | undefined {
  return workflow.stages.find((s) => s.id === id);
}

/** The effective trigger of a route (`on:` absent → `gate`). */
function routeTrigger(route: StageRoute): string {
  return route.on ?? 'gate';
}

/** The stable key identifying a specific dissent record (edge-trigger dedupe). */
export function dissentKey(check: string, record: AttestationRecord): string {
  return `${check}:${record.actor}:${record.at}:${record.commit ?? record.digest ?? 'none'}`;
}

/**
 * The forward "spine" route for placement: the UNIQUE `on: gate` route to a
 * stage LATER in declaration order. Returns `null` when there is none (a waiting
 * stage exited by `work-start`, a terminal, or a branch — see below).
 */
function spineRoute(stage: WorkflowStage, workflow: StageWorkflow): StageRoute | null {
  const order = new Map(workflow.stages.map((s, i) => [s.id, i]));
  const here = order.get(stage.id) ?? -1;
  const forward = (stage.next ?? []).filter(
    (r) => routeTrigger(r) === 'gate' && r.to && (order.get(r.to) ?? -1) > here,
  );
  // A branch (>1 forward gate route) is not a spine — placement stops (the doctor
  // flags it as placement-ambiguous). Exactly one → the spine.
  return forward.length === 1 ? forward[0] : null;
}

/**
 * The placement function (design §2.3): "enter at the deepest stage whose
 * upstream spine gates all pass." A one-shot used ONLY for seeding, reopen, and
 * rebind — never continuously. Judged gates with no evidence fail, so placement
 * honestly stops before an un-rendered review.
 */
export function placeTicket(workflow: StageWorkflow, input: EngineInput): string {
  if (workflow.stages.length === 0) return '';
  let cur = workflow.stages[0];
  const cap = workflow.stages.length;
  for (let i = 0; i < cap; i++) {
    if (cur.terminal) break;
    if (!evaluateGate(cur, input).passed) break;
    const route = spineRoute(cur, workflow);
    if (!route) break;
    const next = stageById(workflow, route.to);
    if (!next) break;
    cur = next;
  }
  return cur.id;
}

/**
 * Placement (as {@link placeTicket}) that STOPS at `capStageId` — it never
 * advances past the cap even if the cap's gate passes (WS-2, for `reopen`: cap
 * at the terminal stage's `reopen:` target so a re-opened ticket lands BEFORE
 * the terminal, at the honest deepest reachable stage ≤ the cap). If the cap id
 * isn't in the workflow the behavior is uncapped (the caller supplies a real
 * reopen target).
 */
export function placeTicketCapped(
  workflow: StageWorkflow,
  input: EngineInput,
  capStageId: string,
): string {
  if (workflow.stages.length === 0) return '';
  let cur = workflow.stages[0];
  const cap = workflow.stages.length;
  for (let i = 0; i < cap; i++) {
    if (cur.id === capStageId) break; // reached the cap — don't advance past it
    if (cur.terminal) break;
    if (!evaluateGate(cur, input).passed) break;
    const route = spineRoute(cur, workflow);
    if (!route) break;
    const next = stageById(workflow, route.to);
    if (!next) break;
    cur = next;
  }
  return cur.id;
}

/**
 * The FAILING gates crossed on the forward slice `[from, to)` of a
 * `manual-override` move (WS-2 / codex r2 finding 3). An override "past a
 * failing gate" bypasses the SOURCE stage's gate (and any intermediate ones) —
 * NOT the target's own exit gate — so those are what get stamped as
 * `GateOverride`s, each entry flagged `overridden: true`. Returns `[]` when `to`
 * is not STRICTLY forward of `from` in declaration order (a backward / off-spine
 * drag crosses nothing — it is re-work, not an override; codex r3 finding 3b).
 */
export function crossedGates(
  workflow: StageWorkflow,
  fromStageId: string,
  toStageId: string,
  input: EngineInput,
): GateSnapshotEntry[] {
  const fromIdx = workflow.stages.findIndex((s) => s.id === fromStageId);
  const toIdx = workflow.stages.findIndex((s) => s.id === toStageId);
  if (fromIdx < 0 || toIdx < 0 || toIdx <= fromIdx) return [];
  const out: GateSnapshotEntry[] = [];
  for (let i = fromIdx; i < toIdx; i++) {
    const stage = workflow.stages[i];
    const gate = evaluateGate(stage, input);
    if (gate.passed) continue;
    for (const c of gate.checks) {
      if (!c.passed) {
        out.push({ key: c.key, label: c.label, passed: false, overridden: true, stage: stage.id });
      }
    }
  }
  return out;
}

/**
 * Evaluate whether a route fires for a given trigger. `gate` auto-advances when
 * the whole gate passes; `work-start` leaves a waiting stage on activity;
 * `verdict` fires `on-dissent` for the first un-fired valid dissent.
 *
 * `verb` (WS-3 Task 0) discriminates work-start moves: a route authored with
 * `verb:` matches only a move carrying the same verb; a verb-less route keeps
 * the match-any behavior — so `implement` at a stage whose only work-start
 * route is `verb: request-review` fires nothing, while dormant/legacy
 * workflows (no verbs authored) behave exactly as before.
 */
export function evaluateRoutes(
  stage: WorkflowStage,
  _workflow: StageWorkflow,
  input: EngineInput,
  trigger: 'gate' | 'work-start' | 'verdict',
  verb?: string,
): { route: StageRoute; trigger: HopTrigger; dissent?: DissentCause } | null {
  if (trigger === 'gate') {
    if (!evaluateGate(stage, input).passed) return null;
    const route = (stage.next ?? []).find((r) => routeTrigger(r) === 'gate');
    return route ? { route, trigger: 'gate' } : null;
  }
  if (trigger === 'work-start') {
    const route = (stage.next ?? []).find(
      (r) => routeTrigger(r) === 'work-start' && (r.verb === undefined || r.verb === verb),
    );
    return route ? { route, trigger: 'work-start' } : null;
  }
  // verdict — any valid dissent on a judged gate check whose record hasn't fired.
  if (!stage.onDissent) return null;
  for (const g of stage.gate ?? []) {
    if (!g.check) continue;
    const evidence = input.evidence[g.check];
    if (!evidence) continue;
    for (const { record, valid } of evidence.records) {
      if (!valid || record.verdict !== 'changes-requested') continue;
      const k = dissentKey(g.check, record);
      if (input.firedDissents.has(k)) continue;
      return {
        route: { to: stage.onDissent },
        trigger: 'verdict',
        dissent: {
          key: k,
          check: g.check,
          actor: record.actor,
          verdict: 'changes-requested',
          note: record.note,
          binding: record.commit ?? record.digest,
        },
      };
    }
  }
  return null;
}

/**
 * Resolve a declared `on: manual` route to `target` (design §2.3). This is
 * scoped to routes explicitly declared with the manual trigger — it does NOT
 * traverse `on: gate` / `on: work-start` edges (those are auto-triggers, not
 * manual affordances). Drag-anywhere / `--force` moves to an arbitrary stage are
 * a SEPARATE audited `manual-override` mechanism (decision #4), owned by WS-4;
 * they do not go through this function.
 */
export function resolveManualRoute(
  stage: WorkflowStage,
  _workflow: StageWorkflow,
  target: string,
): { route: StageRoute } | { error: string } {
  const manualRoutes = (stage.next ?? []).filter((r) => (r.on ?? 'gate') === 'manual' && r.to);
  const route = manualRoutes.find((r) => r.to === target);
  if (route) return { route };
  return {
    error:
      manualRoutes.length > 0
        ? `no manual route from "${stage.id}" to "${target}"; manual routes are: ${manualRoutes.map((r) => r.to).join(', ')}`
        : `no manual routes out of "${stage.id}" (use a --force manual-override to move to an arbitrary stage)`,
  };
}

/**
 * Whether flags suspend auto movement (design §2.6): the built-in `blocked` /
 * `parked` facts, or the per-ticket manual `hold`. Manual moves stay allowed —
 * only the auto-cascade (`advance`) honors this.
 */
export function isPaused(input: EngineInput): boolean {
  return Boolean(input.facts.blocked) || Boolean(input.facts.parked) || Boolean(input.held);
}

/**
 * The one mover: the auto-cascade fixpoint (design §2.3). From `stage`, while an
 * `on: gate` route's gate passes (or an un-fired valid dissent stands), hop —
 * one {@link Hop} per traversal. A verdict route takes priority (it's a brake,
 * not a skip). Terminates on no-fire, terminal arrival, or the hop cap (= stage
 * count, the hard backstop against an ill-formed `on: gate` cycle). Accumulates
 * a local fired-dissent set so a just-fired dissent cannot re-fire this cascade,
 * and returns the newly-fired keys for WS-2 to persist.
 */
export function advance(stage: WorkflowStage, workflow: StageWorkflow, input: EngineInput): AdvanceResult {
  // Flags pause auto movement (design §2.3/§2.6): a blocked/parked/held ticket
  // does not auto-advance (manual moves are still allowed — see resolveManualRoute).
  if (isPaused(input)) return { path: [], final: stage.id, capped: false, firedDissents: [] };
  const path: Hop[] = [];
  const cap = workflow.stages.length;
  const fired = new Set(input.firedDissents);
  const newlyFired: string[] = [];
  let cur = stage;
  for (let i = 0; i < cap; i++) {
    if (cur.terminal) break;
    const localInput: EngineInput = { ...input, firedDissents: fired };
    const step =
      evaluateRoutes(cur, workflow, localInput, 'verdict') ??
      evaluateRoutes(cur, workflow, input, 'gate');
    if (!step) break;
    const next = stageById(workflow, step.route.to);
    if (!next) break; // unknown target — stop (doctor flags it)
    if (step.dissent) {
      fired.add(step.dissent.key);
      newlyFired.push(step.dissent.key);
    }
    path.push({
      from: cur.id,
      to: next.id,
      route: step.route,
      trigger: step.trigger,
      snapshot: snapshot(cur, input),
      dissent: step.dissent,
    });
    cur = next;
  }
  return { path, final: cur.id, capped: path.length >= cap, firedDissents: newlyFired };
}

// ── Regression + cycle detection ─────────────────────────────────────────────

/**
 * Regression policy (design §2.3): a check that admitted the ticket has since
 * gone false. Re-evaluate each traversed snapshot entry that was `passed` (and
 * not `overridden` — those never passed, so can't "break"); a now-false entry is
 * a `flag`. WS-1 emits only `flag`; auto-return awaits an explicit per-check
 * policy field. WS-2 owns the terminal exemption (it passes an empty `traversed`
 * for frozen terminal tickets).
 */
export function checkRegressions(
  traversed: ReadonlyArray<{ stage: string; snapshot: GateSnapshotEntry[] }>,
  workflow: StageWorkflow,
  input: EngineInput,
): RegressionFinding[] {
  const findings: RegressionFinding[] = [];
  for (const passage of traversed) {
    const stage = stageById(workflow, passage.stage);
    if (!stage) continue;
    const live = evaluateGate(stage, input).checks;
    const liveByKey = new Map(live.map((c) => [c.key, c]));
    for (const entry of passage.snapshot) {
      if (!entry.passed || entry.overridden) continue;
      const now = liveByKey.get(entry.key);
      // Require the live predicate at that position to be the SAME one that was
      // snapshotted (label = predicate identity). A gate reordered/edited since
      // traversal → the labels differ → skip rather than re-evaluate a different
      // predicate under the same positional key (a false-flag / miss otherwise).
      if (now && now.label === entry.label && !now.passed) {
        findings.push({ stage: passage.stage, key: entry.key, label: entry.label, policy: 'flag' });
      }
    }
  }
  return findings;
}

/**
 * Detect `on: gate` route cycles and classify them (design §2.3). A cycle
 * containing a stage with an EMPTY gate is unconditionally satisfiable — a
 * guaranteed livelock the hop cap would silently cap → `error`. Any other
 * `on: gate` cycle → `warning` (full AQL satisfiability is out of scope; the hop
 * cap is the runtime guarantee). Uses Tarjan's SCC over the `on: gate` subgraph.
 */
export function detectAutoRouteCycles(workflow: StageWorkflow): CycleDiagnostic[] {
  const ids = workflow.stages.map((s) => s.id);
  const idSet = new Set(ids);
  const adj = new Map<string, string[]>();
  for (const s of workflow.stages) {
    const outs: string[] = [];
    for (const r of s.next ?? []) {
      if ((r.on ?? 'gate') === 'gate' && r.to && idSet.has(r.to)) outs.push(r.to);
    }
    adj.set(s.id, outs);
  }
  const gateSize = new Map(workflow.stages.map((s) => [s.id, (s.gate ?? []).length]));

  // Tarjan's strongly-connected components.
  let counter = 0;
  const indexOf = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Map<string, boolean>();
  const stack: string[] = [];
  const sccs: string[][] = [];
  const strongconnect = (v: string): void => {
    indexOf.set(v, counter);
    low.set(v, counter);
    counter++;
    stack.push(v);
    onStack.set(v, true);
    for (const w of adj.get(v) ?? []) {
      if (!indexOf.has(w)) {
        strongconnect(w);
        low.set(v, Math.min(low.get(v)!, low.get(w)!));
      } else if (onStack.get(w)) {
        low.set(v, Math.min(low.get(v)!, indexOf.get(w)!));
      }
    }
    if (low.get(v) === indexOf.get(v)) {
      const comp: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        onStack.set(w, false);
        comp.push(w);
      } while (w !== v);
      sccs.push(comp);
    }
  };
  for (const id of ids) if (!indexOf.has(id)) strongconnect(id);

  const diagnostics: CycleDiagnostic[] = [];
  for (const comp of sccs) {
    // A cycle = an SCC of size > 1, or a single stage with a self-loop.
    const isCycle = comp.length > 1 || (adj.get(comp[0]) ?? []).includes(comp[0]);
    if (!isCycle) continue;
    const path = comp.slice().reverse(); // Tarjan pops in reverse discovery order
    const hasEmptyGate = comp.some((id) => (gateSize.get(id) ?? 0) === 0);
    diagnostics.push(
      hasEmptyGate
        ? {
            severity: 'error',
            path,
            reason: `on: gate cycle through [${path.join(' → ')}] includes an unconditional (empty) gate — a guaranteed livelock`,
          }
        : {
            severity: 'warning',
            path,
            reason: `on: gate cycle through [${path.join(' → ')}] — its gates may be simultaneously satisfiable`,
          },
    );
  }
  return diagnostics;
}
