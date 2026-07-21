/**
 * Ladder → StageWorkflow compiler (WS-3, Tasks 1+2).
 *
 * Compiles a derive phase LADDER (ordered `PhaseRung[]`, each `when` an AQL
 * condition) into a per-file {@link StageWorkflow}: a gated cascade + explicit
 * `work-start` routes + terminal stages — alongside a forced-decision COMPILE
 * REPORT a human reviews before the migration applies (design §4.1/§4.2).
 *
 * **The compile rule** (plan-review round-2 blocker 3 — the crux). For each
 * consecutive rung pair `stage_i → stage_{i+1}`, take `when(rung_{i+1})` and
 * remove conjuncts already implied by being at `stage_i` (i.e. conjuncts of
 * `when(rung_i)` and all earlier rungs). Partition the RESIDUAL conjuncts:
 *
 *   - a positive retired work-start fact (`implementationStarted:true` /
 *     `reviewRequested:true` / `reworkRequested:true`) → an `on: work-start`
 *     route carrying its verb (`implement` / `request-review` / `rework`),
 *     NEVER a gate;
 *   - a NEGATED retired fact (`NOT reworkRequested:true`) → stays in the gate
 *     as a hold AND compiles a RETURN work-start route `stage_{i+1} → stage_i`
 *     with the mapped verb (the ladder demotes on the fact going true; the
 *     engine moves on the verb);
 *   - an OR conjunct → retired-positive disjuncts are extracted into work-start
 *     routes; the remaining disjuncts stay in the gate (rejoined raw — the
 *     `condition:` escape hatch — when more than one remains);
 *   - every other conjunct is MEANINGFUL → part of the gate condition.
 *
 * A gate route is emitted iff meaningful conjuncts remain. If the residual is
 * ONLY retired work-start facts, the stage gets the work-start route and NO
 * gate — otherwise it would auto-advance without the command (the
 * `ready_to_implement → in_progress` bug).
 *
 * **Terminal reachability.** Doctor rejects both missing terminals and
 * unreachable stages, and `complete`/`fail` are runtime manual-overrides it
 * does not count — so explicit `on: manual` routes are authored INTO the
 * terminals: every work-start-TARGET stage (where an agent actively works) gets
 * a manual route to each success terminal, and the LAST rung additionally
 * routes to the failure terminal.
 *
 * **Pure** — no I/O; returns `{ workflow, report }`. The command (T3) does the
 * reading/writing.
 */

import type { StatusConfig } from '../utils/config.js';
import { DEFAULT_DERIVE_CONFIG, type DeriveConfig, type PhaseRung } from '../utils/derive-config.js';
import type { StageRoute, StageWorkflow, WorkflowFlags, WorkflowStage } from '../utils/stage-model.js';

// ── Report model ─────────────────────────────────────────────────────────────

/** One forced-decision row: what the compiler did with one conjunct and why. */
export interface CompileEdgeDecision {
  /** The rung pair this conjunct belongs to (`from` = stage_i, `to` = stage_{i+1}). */
  from: string;
  to: string;
  /** The conjunct (or disjunct) of `when(rung_{i+1})` being decided. */
  conjunct: string;
  /** What it compiled to. */
  outcome: 'implied' | 'gate' | 'work-start' | 'raw-or';
  /** The work-start verb, for `work-start` outcomes. */
  verb?: string;
  /** WHY — the human-readable rationale for the forced decision. */
  reason: string;
}

/** One orphan status (in definitions/order; no rung, no route, not terminal,
 * not a flag) with its forced decision (D2 default: delete-if-unused). */
export interface OrphanDecision {
  id: string;
  decision: 'delete-if-unused' | 'wire' | 'manual-only';
  reason: string;
}

/** The semantic caveat every compile report surfaces (design §4.1 / risk b). */
export const COMPILE_SEMANTIC_CAVEAT =
  'The ladder RE-RANKS a ticket by its best-matching rung on every read; stages FREEZE the ' +
  'stored position and only advance through gates/routes. Seeded positions are point-in-time.';

export interface LadderCompileReport {
  workflowId: string;
  /** Every per-conjunct forced decision, in rung order. */
  decisions: CompileEdgeDecision[];
  /** True orphans with their proposed resolution (T2 / decision D2). */
  orphans: OrphanDecision[];
  /** The compiled terminal stage ids, in order. */
  terminals: string[];
  /** Flag definitions compiled from the disposition rules (name → `when`). */
  flags: Record<string, string | null>;
  /** The semantic caveat (ladder re-ranks vs. stages freeze history). */
  caveat: string;
}

// ── Retired work-start facts ─────────────────────────────────────────────────

/** Retired session-stage facts → the work-start verb that replaces them
 * (post-marker, the verbs become `engineMove: {kind:'work-start', verb}`). */
export const RETIRED_FACT_VERBS: Record<string, string> = {
  implementationstarted: 'implement',
  reviewrequested: 'request-review',
  reworkrequested: 'rework',
};

// ── Conjunct parsing (tiny, structural — not a full AQL parse) ───────────────

/** Split an expression on a top-level (depth-0, unquoted) boolean keyword. */
function splitTopLevel(expr: string, keyword: 'AND' | 'OR'): string[] {
  const parts: string[] = [];
  let depth = 0;
  let inQuote: string | null = null;
  let start = 0;
  const re = new RegExp(`^${keyword}\\b`, 'i');
  for (let i = 0; i < expr.length; i++) {
    const ch = expr[i];
    if (inQuote) {
      if (ch === inQuote) inQuote = null;
      continue;
    }
    if (ch === '"' || ch === "'") inQuote = ch;
    else if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (depth === 0 && (ch === 'A' || ch === 'a' || ch === 'O' || ch === 'o')) {
      // Keyword boundary: preceded by start/whitespace/`)` and matching the word.
      const prev = i === 0 ? ' ' : expr[i - 1];
      if ((/[\s)]/.test(prev) || i === 0) && re.test(expr.slice(i))) {
        parts.push(expr.slice(start, i).trim());
        i += keyword.length;
        start = i;
        i--; // for-loop increment compensation
      }
    }
  }
  parts.push(expr.slice(start).trim());
  return parts.filter((p) => p.length > 0);
}

/** Strip one level of enclosing parentheses when they wrap the WHOLE expression. */
function stripOuterParens(expr: string): string {
  let s = expr.trim();
  while (s.startsWith('(') && s.endsWith(')')) {
    let depth = 0;
    let wraps = true;
    for (let i = 0; i < s.length; i++) {
      if (s[i] === '(') depth++;
      else if (s[i] === ')') {
        depth--;
        if (depth === 0 && i < s.length - 1) {
          wraps = false;
          break;
        }
      }
    }
    if (!wraps) break;
    s = s.slice(1, -1).trim();
  }
  return s;
}

/** Normalize a conjunct for entailment comparison (case/whitespace/parens). */
function normalizeConjunct(expr: string): string {
  return stripOuterParens(expr).replace(/\s+/g, ' ').trim().toLowerCase();
}

/** The retired-fact verb for a POSITIVE atom (`implementationStarted:true`), or null. */
function positiveRetiredVerb(conjunct: string): string | null {
  const m = stripOuterParens(conjunct).match(/^([A-Za-z_]\w*)\s*:\s*true$/i);
  return m ? (RETIRED_FACT_VERBS[m[1].toLowerCase()] ?? null) : null;
}

/** The retired-fact verb for a NEGATED atom (`NOT reworkRequested:true` /
 * `reworkRequested:false`), or null. */
function negatedRetiredVerb(conjunct: string): string | null {
  const s = stripOuterParens(conjunct);
  const not = s.match(/^NOT\s+([A-Za-z_]\w*)\s*:\s*true$/i);
  if (not) return RETIRED_FACT_VERBS[not[1].toLowerCase()] ?? null;
  const falsy = s.match(/^([A-Za-z_]\w*)\s*:\s*false$/i);
  return falsy ? (RETIRED_FACT_VERBS[falsy[1].toLowerCase()] ?? null) : null;
}

/** Conjuncts of a rung's `when` (`*` — match-all — contributes none). */
function conjunctsOf(when: string): string[] {
  const trimmed = when.trim();
  if (trimmed === '*' || trimmed === '') return [];
  return splitTopLevel(trimmed, 'AND');
}

// ── The compiler ─────────────────────────────────────────────────────────────

/**
 * Classify every status id of the bundle from its ACTUAL role in the loaded
 * config — never a hardcoded list (T2 / decision D2): rung phase → gated
 * stage; `terminal: true` → terminal stage; a disposition-rule target
 * (`blocked`/`parked`) → flag; everything else → true orphan.
 */
export function classifyStatuses(
  bundle: StatusConfig,
  derive: DeriveConfig,
): { rungs: Set<string>; terminals: string[]; flagIds: Set<string>; orphans: string[] } {
  const rungs = new Set(derive.phaseLadder.map((r) => r.phase));
  const defined = bundle.statuses.map((s) => s.id);
  // Definition order (via `order:` where present, then any stragglers) — but
  // never `order:` as an implicit gate spine: it only sequences the report.
  const ordered = [
    ...bundle.order.filter((id) => defined.includes(id)),
    ...defined.filter((id) => !bundle.order.includes(id)),
  ];
  const terminalSet = new Set(bundle.statuses.filter((s) => s.terminal).map((s) => s.id));
  const terminals = ordered.filter((id) => terminalSet.has(id));
  // Flag ids: the disposition-rule targets (`is`) of non-else rules, plus the
  // headline projection's parked/blocked status ids (the same ids, by default).
  const flagIds = new Set<string>();
  for (const rule of derive.disposition) {
    if (rule.when !== null && rule.is !== 'active') flagIds.add(rule.is);
  }
  flagIds.add(derive.headline.parked);
  flagIds.add(derive.headline.blocked);
  const orphans = ordered.filter(
    (id) => !rungs.has(id) && !terminalSet.has(id) && !flagIds.has(id),
  );
  return { rungs, terminals, flagIds, orphans };
}

/**
 * Compile one ladder workflow bundle into a {@link StageWorkflow} + report.
 * `bundle.derive ?? DEFAULT_DERIVE_CONFIG` mirrors `buildDeriveContext` — the
 * live `default` workflow has no `derive:` block and uses the built-in ladder.
 */
export function compileLadderWorkflow(
  id: string,
  bundle: StatusConfig,
): { workflow: StageWorkflow; report: LadderCompileReport } {
  const derive = bundle.derive ?? DEFAULT_DERIVE_CONFIG;
  const ladder: PhaseRung[] = derive.phaseLadder;
  const decisions: CompileEdgeDecision[] = [];

  // Per-stage route/gate accumulation, keyed by rung phase.
  const gates = new Map<string, string[]>(); // stage_i → gate conjuncts
  const routes = new Map<string, StageRoute[]>(); // stage id → routes (in emit order)
  const routeFor = (stage: string): StageRoute[] => {
    let r = routes.get(stage);
    if (!r) {
      r = [];
      routes.set(stage, r);
    }
    return r;
  };

  // Conjuncts entailed by being at stage_i: when(rung_i) and all earlier rungs.
  const implied = new Set<string>();
  for (let i = 0; i < ladder.length - 1; i++) {
    const from = ladder[i];
    const to = ladder[i + 1];
    for (const c of conjunctsOf(from.when)) implied.add(normalizeConjunct(c));

    const gateConjuncts: string[] = [];
    const workStart: Array<{ verb: string }> = [];

    for (const conjunct of conjunctsOf(to.when)) {
      if (implied.has(normalizeConjunct(conjunct))) {
        decisions.push({
          from: from.phase,
          to: to.phase,
          conjunct,
          outcome: 'implied',
          reason: `already implied by being at "${from.phase}" (a conjunct of an earlier rung) — removed`,
        });
        continue;
      }
      const positive = positiveRetiredVerb(conjunct);
      if (positive) {
        workStart.push({ verb: positive });
        decisions.push({
          from: from.phase,
          to: to.phase,
          conjunct,
          outcome: 'work-start',
          verb: positive,
          reason: `retired work-start fact → an on:work-start route (verb: ${positive}), never a gate`,
        });
        continue;
      }
      const negated = negatedRetiredVerb(conjunct);
      if (negated) {
        // The hold stays in the gate; the fact-going-true demotion becomes a
        // RETURN work-start route from stage_{i+1} back to stage_i.
        gateConjuncts.push(conjunct);
        decisions.push({
          from: from.phase,
          to: to.phase,
          conjunct,
          outcome: 'gate',
          reason: 'negated retired fact: kept in the gate as a hold',
        });
        routeFor(to.phase).push({ to: from.phase, on: 'work-start', verb: negated });
        decisions.push({
          from: to.phase,
          to: from.phase,
          conjunct,
          outcome: 'work-start',
          verb: negated,
          reason: `retired-fact demotion → a return on:work-start route (verb: ${negated}) from "${to.phase}"`,
        });
        continue;
      }
      // OR conjunct: extract retired-positive disjuncts into work-start routes;
      // the rest stays in the gate (rejoined raw when more than one remains).
      const disjuncts = splitTopLevel(stripOuterParens(conjunct), 'OR');
      if (disjuncts.length > 1) {
        const remaining: string[] = [];
        for (const d of disjuncts) {
          const verb = positiveRetiredVerb(d);
          if (verb) {
            workStart.push({ verb });
            decisions.push({
              from: from.phase,
              to: to.phase,
              conjunct: d,
              outcome: 'work-start',
              verb,
              reason: `retired work-start fact (an OR disjunct) → an on:work-start route (verb: ${verb})`,
            });
          } else {
            remaining.push(d);
          }
        }
        if (remaining.length === 1) {
          gateConjuncts.push(remaining[0]);
          decisions.push({
            from: from.phase,
            to: to.phase,
            conjunct: remaining[0],
            outcome: 'gate',
            reason: 'the meaningful remainder of an OR conjunct → gate condition',
          });
        } else if (remaining.length > 1) {
          const raw = `(${remaining.join(' OR ')})`;
          gateConjuncts.push(raw);
          decisions.push({
            from: from.phase,
            to: to.phase,
            conjunct: raw,
            outcome: 'raw-or',
            reason: 'irreducible OR → kept raw via the condition: escape hatch',
          });
        }
        continue;
      }
      gateConjuncts.push(conjunct);
      decisions.push({
        from: from.phase,
        to: to.phase,
        conjunct,
        outcome: 'gate',
        reason: 'meaningful conjunct (not implied, not a retired fact) → gate condition',
      });
    }

    // Emit a gate route iff meaningful conjuncts remain; a residual of ONLY
    // retired facts gets the work-start route and NO gate (else the stage
    // auto-advances without the command). An EMPTY residual (everything
    // implied) still needs a declared way forward — an unconditional gate.
    const stageRoutes = routeFor(from.phase);
    if (gateConjuncts.length > 0 || workStart.length === 0) {
      if (gateConjuncts.length > 0) gates.set(from.phase, gateConjuncts);
      stageRoutes.unshift({ to: to.phase, on: 'gate' });
      if (gateConjuncts.length === 0) {
        decisions.push({
          from: from.phase,
          to: to.phase,
          conjunct: '(none)',
          outcome: 'gate',
          reason: 'empty residual — an unconditional gate route (auto-advance) was emitted',
        });
      }
    } else {
      decisions.push({
        from: from.phase,
        to: to.phase,
        conjunct: '(residual)',
        outcome: 'work-start',
        reason: `residual is ONLY retired work-start fact(s) → work-start route and NO gate (no auto-advance)`,
      });
    }
    // De-duplicate verbs (an OR can surface the same retired fact twice).
    const seenVerbs = new Set<string>();
    for (const ws of workStart) {
      if (seenVerbs.has(ws.verb)) continue;
      seenVerbs.add(ws.verb);
      stageRoutes.push({ to: to.phase, on: 'work-start', verb: ws.verb });
    }
  }

  // ── Terminals, manual reachability routes, flags, orphans ─────────────────
  const { terminals, orphans } = classifyStatuses(bundle, derive);
  const lastRung = ladder[ladder.length - 1]?.phase;

  // The failure terminal: a `command: fail` transition target when the bundle
  // declares one; else the terminal literally id'd `failed`.
  const failTransition = (bundle.transitions ?? []).find(
    (t) => t.command === 'fail' && terminals.includes(t.to),
  );
  const terminalFailure =
    failTransition?.to ?? (terminals.includes('failed') ? 'failed' : undefined);
  const successTerminals = terminals.filter((t) => t !== terminalFailure);

  // Manual routes INTO the terminals (doctor reachability): every work-start
  // TARGET stage → each success terminal; the last rung → failure terminal too.
  const workStartTargets = new Set<string>();
  for (const rs of routes.values()) {
    for (const r of rs) if (r.on === 'work-start') workStartTargets.add(r.to);
  }
  for (const rung of ladder) {
    const stageRoutes = routeFor(rung.phase);
    const has = (to: string): boolean => stageRoutes.some((r) => r.on === 'manual' && r.to === to);
    if (workStartTargets.has(rung.phase) || rung.phase === lastRung) {
      for (const t of successTerminals) if (!has(t)) stageRoutes.push({ to: t, on: 'manual' });
    }
    if (rung.phase === lastRung && terminalFailure && !has(terminalFailure)) {
      stageRoutes.push({ to: terminalFailure, on: 'manual' });
    }
  }

  // Flags from the disposition rules (name → when), plus the manual `hold`.
  // Emitted blocked-first to match the authored shape; key order is cosmetic.
  const flags: WorkflowFlags = {};
  const flagWhen = new Map<string, string>();
  for (const rule of derive.disposition) {
    if (rule.when !== null && rule.is !== 'active') flagWhen.set(rule.is, rule.when);
  }
  for (const name of ['blocked', 'parked']) {
    const when = flagWhen.get(name);
    if (when !== undefined) {
      flags[name] = { when };
      flagWhen.delete(name);
    }
  }
  for (const [name, when] of flagWhen) flags[name] = { when };
  flags.hold = {};

  // ── Assemble the workflow: rung stages in ladder order, then terminals ────
  const stages: WorkflowStage[] = [];
  for (const rung of ladder) {
    const stage: WorkflowStage = { id: rung.phase };
    const gateConjuncts = gates.get(rung.phase);
    if (gateConjuncts) stage.gate = [{ check: '', condition: gateConjuncts.join(' AND ') }];
    const stageRoutes = routes.get(rung.phase);
    if (stageRoutes && stageRoutes.length > 0) stage.next = stageRoutes;
    stages.push(stage);
  }
  for (const t of terminals) {
    const stage: WorkflowStage = { id: t, terminal: true };
    if (lastRung) stage.reopen = lastRung;
    stages.push(stage);
  }

  const workflow: StageWorkflow = { id, stages, flags };
  if (terminalFailure) workflow.terminalFailure = terminalFailure;

  const report: LadderCompileReport = {
    workflowId: id,
    decisions,
    orphans: orphans.map((o) => ({
      id: o,
      decision: 'delete-if-unused',
      reason:
        `status "${o}" is defined but sits on no rung, no route, is not terminal and not a flag — ` +
        'forced decision: delete (if unused) / wire into the workflow / keep manual-only',
    })),
    terminals,
    flags: Object.fromEntries(
      Object.entries(flags).map(([name, def]) => [name, def?.when ?? null]),
    ),
    caveat: COMPILE_SEMANTIC_CAVEAT,
  };

  return { workflow, report };
}
