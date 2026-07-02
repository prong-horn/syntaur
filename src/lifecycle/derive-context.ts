/**
 * The derive context — the resolved, per-lifecycle bundle every recompute runs
 * against: the derive rules, the terminal/known status sets, the accepted custom
 * fact declarations, and the compiled fact registry.
 *
 * Historically there was ONE global context, built inside `resolveDeriveContext`
 * from `config.statuses`. With multiple workflows, each ticket resolves its OWN
 * context from its workflow's bundle. {@link buildDeriveContext} is the single
 * constructor both the global resolver (`resolveDeriveContext`,
 * `lifecycle/recompute.ts`) and the per-workflow helper
 * (`resolveAssignmentWorkflowContext`, `lifecycle/workflow-context.ts`) call, so
 * the two can never drift — the core "one derive-context construction" invariant.
 *
 * Node-safe leaf module (no imports of recompute/workflow-context) so both can
 * import it without a cycle.
 */
import {
  acceptFactDeclarations,
  buildDeriveRegistry,
  normalizeFactDeclarations,
  type FactDeclaration,
} from '../utils/fact-registry.js';
import { DEFAULT_DERIVE_CONFIG, type DeriveConfig } from '../utils/derive-config.js';
import { DEFAULT_TERMINAL_STATUSES } from './types.js';
import type { FieldRegistry } from '../utils/query/index.js';
import type { StatusConfig } from '../utils/config.js';

export interface DeriveContext {
  derive: DeriveConfig;
  terminalStatuses: ReadonlySet<string>;
  knownStatusIds: ReadonlySet<string>;
  /** ACCEPTED custom-fact declarations (normalize→accept output) — resolved
   * once and passed to computeFacts so every recompute speaks one vocabulary. */
  factDeclarations: FactDeclaration[];
  /** Derive registry built from the accepted declarations — ONE per config
   * resolution so the compile-condition cache stays warm across sweeps. */
  registry: FieldRegistry;
}

/**
 * Build a {@link DeriveContext} from a single status-config bundle — a workflow's
 * `definitions/order/transitions/derive/facts`, or the legacy global
 * `config.statuses`. Runs the fact pipeline ONCE (raw → normalize (drop
 * malformed) → accept (drop collisions)) and compiles ONE registry, so the
 * compile-condition cache stays warm for every consumer of this context. A
 * bundle with no terminal-flagged status falls back to the built-in terminal set
 * (completed/failed) — matching the pre-workflow global resolver exactly.
 */
export function buildDeriveContext(bundle: StatusConfig): DeriveContext {
  const terminal = new Set(bundle.statuses.filter((s) => s.terminal).map((s) => s.id));
  const accepted = acceptFactDeclarations(normalizeFactDeclarations(bundle.facts ?? null));
  return {
    derive: bundle.derive ?? DEFAULT_DERIVE_CONFIG,
    terminalStatuses: terminal.size > 0 ? terminal : DEFAULT_TERMINAL_STATUSES,
    knownStatusIds: new Set(bundle.statuses.map((s) => s.id)),
    factDeclarations: accepted,
    registry: buildDeriveRegistry(accepted),
  };
}
