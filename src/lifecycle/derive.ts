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

import type { DeriveConfig } from '../utils/derive-config.js';
import { compileNode, CompileError, parseQuery, type Predicate, type FieldRegistry } from '../utils/query/index.js';
import type { StatusOverride } from './types.js';
import { DERIVE_FIELDS } from '../utils/fact-registry.js';

// Re-export all fact-vocabulary symbols so existing imports from this module
// keep resolving without change.
export type { FactDeclaration } from '../utils/fact-registry.js';
export type { FactFieldNames } from '../utils/fact-registry.js';
export {
  DERIVE_FIELDS,
  factFieldNames,
  acceptFactDeclarations,
  addFactFields,
  buildDeriveRegistry,
  buildQueryRegistry,
  queryFieldNames,
} from '../utils/fact-registry.js';

/** The fixed built-in fact set (the 14 derived-status v3 facts). Custom facts
 * extend {@link AssignmentFacts} dynamically via the config-declared registry. */
export interface BuiltinFacts {
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
 * The fact set dimensions derive from. Computed by `facts.ts` (Node) or shipped
 * in dashboard payloads (browser). The 14 built-ins are always present; custom
 * declared facts (bool/number) and attestation exports (`<name>`,
 * `<name>Approved`, … as boolean / actor `string[]`) ride in the open index.
 */
export type AssignmentFacts = BuiltinFacts &
  Record<string, boolean | number | string[]>;

/** Validate one derive condition against a field registry (defaults to the
 * facts-only base). Returns an error message or null. Plugs into
 * validateDeriveConfig; pass a custom registry to accept declared fact names. */
export function validateDeriveCondition(
  when: string,
  registry: FieldRegistry = DERIVE_FIELDS,
): string | null {
  if (when === '*') return null;
  const parsed = parseQuery(when);
  if (!parsed.ast) return parsed.errors[0]?.message ?? 'unparseable condition';
  try {
    compileNode(parsed.ast, registry);
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

// Compiled-condition cache, keyed by REGISTRY object identity — config reloads
// and config-resolution build a fresh registry → fresh cache. Keying by
// registry (not config) lets all default-config derivations share the base
// DERIVE_FIELDS cache, while a custom-vocabulary config gets its own. Callers
// must build ONE registry per config resolution for sweeps to stay cached.
const conditionCache = new WeakMap<FieldRegistry, Map<string, Predicate>>();

function compiledWhen(registry: FieldRegistry, when: string): Predicate {
  let cache = conditionCache.get(registry);
  if (!cache) {
    cache = new Map();
    conditionCache.set(registry, cache);
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
      pred = compileNode(parsed.ast, registry);
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
  /** Field registry the `when` conditions compile against. Defaults to the base
   * facts-only registry; callers with custom facts pass the resolution's
   * `buildDeriveRegistry(...)` output (ONE per config resolution — see the
   * compile-cache note). */
  registry?: FieldRegistry;
}

/**
 * Derive phase/disposition/headline for one assignment. Returns `null` when
 * the assignment is terminal — derivation defers entirely until `reopen`.
 */
export function deriveDimensions(input: DeriveInput): DerivedDimensions | null {
  const { facts, derive, currentStatus, terminalStatuses, knownStatusIds, override } = input;
  const registry = input.registry ?? DERIVE_FIELDS;

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
    if (compiledWhen(registry, rung.when)(item, ctx)) {
      phase = rung.phase;
      nextAction = rung.next ?? null;
      break;
    }
  }

  // Disposition: first match wins; `when: null` is the else arm.
  let disposition: DerivedDimensions['disposition'] = 'active';
  for (const rule of derive.disposition) {
    if (rule.when === null || compiledWhen(registry, rule.when)(item, ctx)) {
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
