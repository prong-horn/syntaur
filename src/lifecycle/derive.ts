/**
 * Derived-status dimension engine (design v3, Piece 2) — PURE.
 *
 * Evaluates the configured phase ladder + disposition rules over an
 * assignment's facts and projects the headline status. No filesystem access
 * and no Node-only imports — the dashboard client can evaluate the same rules
 * over server-materialized facts. Fact *computation* lives in `facts.ts`
 * (Node-side).
 *
 * Invariants enforced here:
 *  - Terminal assignments defer entirely: callers get `null` and must leave
 *    every dimension as-is (terminal is reached only via the gated
 *    complete/fail transitions; `reopen` re-enters derivation).
 *  - Derive conditions evaluate over FACTS ONLY (`DERIVE_FIELDS`): time-based
 *    fields are not in the registry, so a `statusAge > 3d` rung is a config
 *    validation error — time drives payload flags, never dimensions.
 *  - The override is folded into the effective status here (write-side), but
 *    a terminal or unknown override target is ignored (defense in depth — the
 *    pin CLI already refuses those).
 */

import type { DeriveConfig } from '../utils/config.js';
import { compileNode, CompileError, parseQuery, type Predicate } from '../utils/query/index.js';
import type { FieldRegistry } from '../utils/query/index.js';
import type { StatusOverride } from './types.js';

/** The fact set dimensions derive from. Computed by `facts.ts` (Node) or
 * shipped in dashboard payloads (browser). */
export interface AssignmentFacts {
  hasRealObjective: boolean;
  acRealTotal: number;
  acRealChecked: number;
  acAllChecked: boolean;
  planExists: boolean;
  planApproved: boolean;
  workspaceSet: boolean;
  implementationStarted: boolean;
  depsSatisfied: boolean;
  unresolvedQuestions: number;
  blocked: boolean;
  parked: boolean;
  reviewRequested: boolean;
  pinned: boolean;
}

/**
 * Registry for derive conditions: facts only. Deliberately excludes
 * timestamps/durations (statusAge, created, …) and identity fields — a derive
 * rule referencing them fails validation, implementing "time-based facts are
 * payload-only flags" with teeth.
 */
export const DERIVE_FIELDS: FieldRegistry = {
  hasrealobjective: { kind: 'bool', get: (i) => i['hasRealObjective'] },
  acrealtotal: { kind: 'number', get: (i) => i['acRealTotal'] },
  acrealchecked: { kind: 'number', get: (i) => i['acRealChecked'] },
  acallchecked: { kind: 'bool', get: (i) => i['acAllChecked'] },
  planexists: { kind: 'bool', get: (i) => i['planExists'] },
  planapproved: { kind: 'bool', get: (i) => i['planApproved'] },
  workspaceset: { kind: 'bool', get: (i) => i['workspaceSet'] },
  implementationstarted: { kind: 'bool', get: (i) => i['implementationStarted'] },
  depssatisfied: { kind: 'bool', get: (i) => i['depsSatisfied'] },
  unresolvedquestions: { kind: 'number', get: (i) => i['unresolvedQuestions'] },
  blocked: { kind: 'bool' },
  parked: { kind: 'bool' },
  reviewrequested: { kind: 'bool', get: (i) => i['reviewRequested'] },
  pinned: { kind: 'bool' },
};

/** Validate one derive condition against the facts-only registry.
 * Returns an error message or null. Plugs into validateDeriveConfig. */
export function validateDeriveCondition(when: string): string | null {
  if (when === '*') return null;
  const parsed = parseQuery(when);
  if (!parsed.ast) return parsed.errors[0]?.message ?? 'unparseable condition';
  try {
    compileNode(parsed.ast, DERIVE_FIELDS);
    return null;
  } catch (err) {
    if (err instanceof CompileError) return err.errors[0]?.message ?? 'invalid condition';
    throw err;
  }
}

export interface DerivedDimensions {
  /** Highest satisfied ladder rung (regressible — replan can drop it). */
  phase: string;
  disposition: 'active' | 'blocked' | 'parked';
  /** Headline projection BEFORE the override — payload-only, powers the
   * "pinned to X — would otherwise be Y" divergence display. */
  derivedStatus: string;
  /** Effective headline (override folded in) — what gets written to `status`. */
  status: string;
  /** The matched rung's `next:` label — the per-ticket call to action. */
  nextAction: string | null;
}

// Compiled-condition cache, keyed by config object identity (config reloads
// produce a new object → fresh cache). Matters for recompute-all sweeps.
const conditionCache = new WeakMap<DeriveConfig, Map<string, Predicate>>();

function compiledWhen(derive: DeriveConfig, when: string): Predicate {
  let cache = conditionCache.get(derive);
  if (!cache) {
    cache = new Map();
    conditionCache.set(derive, cache);
  }
  let pred = cache.get(when);
  if (!pred) {
    if (when === '*') {
      pred = () => true;
    } else {
      const parsed = parseQuery(when);
      if (!parsed.ast) {
        throw new CompileError(parsed.errors);
      }
      pred = compileNode(parsed.ast, DERIVE_FIELDS);
    }
    cache.set(when, pred);
  }
  return pred;
}

export interface DeriveInput {
  facts: AssignmentFacts;
  derive: DeriveConfig;
  /** Current headline status from frontmatter (for the terminal check). */
  currentStatus: string;
  terminalStatuses: ReadonlySet<string>;
  /** Defined status ids — headline targets outside this set fall back to phase. */
  knownStatusIds: ReadonlySet<string>;
  override: StatusOverride | null;
}

/**
 * Derive phase/disposition/headline for one assignment. Returns `null` when
 * the assignment is terminal — derivation defers entirely until `reopen`.
 */
export function deriveDimensions(input: DeriveInput): DerivedDimensions | null {
  const { facts, derive, currentStatus, terminalStatuses, knownStatusIds, override } = input;

  if (terminalStatuses.has(currentStatus)) return null;

  const ctx = { now: 0 }; // derive conditions are time-free by construction
  const item = facts as unknown as Record<string, unknown>;

  // Phase: HIGHEST satisfied rung wins (iterate top-down). The bottom rung is
  // conventionally `*`; if nothing matches (misconfigured ladder), fall back
  // to the bottom rung's phase rather than inventing a status.
  let phase = derive.phaseLadder[0]?.phase ?? currentStatus;
  let nextAction: string | null = derive.phaseLadder[0]?.next ?? null;
  for (let i = derive.phaseLadder.length - 1; i >= 0; i--) {
    const rung = derive.phaseLadder[i];
    if (compiledWhen(derive, rung.when)(item, ctx)) {
      phase = rung.phase;
      nextAction = rung.next ?? null;
      break;
    }
  }

  // Disposition: first match wins; `when: null` is the else arm.
  let disposition: DerivedDimensions['disposition'] = 'active';
  for (const rule of derive.disposition) {
    if (rule.when === null || compiledWhen(derive, rule.when)(item, ctx)) {
      disposition = rule.is as DerivedDimensions['disposition'];
      break;
    }
  }

  // Headline projection. Unknown target ids (e.g. parked without a `parked`
  // status definition) fall back to the phase so the board never shows an
  // undefined status; doctor surfaces the missing definition.
  let derivedStatus: string;
  switch (disposition) {
    case 'parked':
      derivedStatus = knownStatusIds.has(derive.headline.parked) ? derive.headline.parked : phase;
      break;
    case 'blocked':
      derivedStatus = knownStatusIds.has(derive.headline.blocked) ? derive.headline.blocked : phase;
      break;
    default:
      derivedStatus = phase;
  }

  // Fold the override (effective = override ?? derived). Terminal or unknown
  // targets are ignored — the pin CLI refuses them, this is defense in depth.
  let status = derivedStatus;
  if (
    override &&
    override.status &&
    !terminalStatuses.has(override.status) &&
    knownStatusIds.has(override.status)
  ) {
    status = override.status;
  }

  return { phase, disposition, derivedStatus, status, nextAction };
}
