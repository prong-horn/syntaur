/**
 * Browser-safe derive-config primitives.
 *
 * Extracted from `config.ts` (which is Node-heavy — `node:fs/promises`,
 * `node:child_process`, etc. — and cannot be aliased into the Vite/browser
 * build). This module has ZERO imports so the dashboard client can alias it
 * (`@shared/derive-config`) and reuse the exact same validator the server and
 * `doctor` run, guaranteeing client/server/doctor parity.
 *
 * `config.ts` re-exports everything here so existing Node-side imports from
 * `config.js` keep resolving unchanged.
 */

/** One rung of the phase ladder (derived-status v3). Ordered low → high; the
 * HIGHEST rung whose AQL `when` holds wins. Regressible by design (e.g. a
 * replan invalidates approval and the phase drops). `phase` must be a defined
 * status id; `next` is the human next-action label surfaced by views. */
export interface PhaseRung {
  phase: string;
  when: string;
  next?: string;
}

/** One disposition rule (first match wins). `when: null` is the `else` arm.
 * `is` ∈ active|blocked|parked (terminal is never a rule — terminal statuses
 * defer derivation entirely). */
export interface DispositionRule {
  when: string | null;
  is: string;
}

/** Headline projection: which status id the single-column board shows.
 * `terminal` is always passthrough and `active` always shows the phase; the
 * configurable parts are which status ids represent parked/blocked. */
export interface HeadlineProjection {
  terminal: 'passthrough';
  parked: string;
  blocked: string;
  active: 'phase';
}

export interface DeriveConfig {
  phaseLadder: PhaseRung[];
  disposition: DispositionRule[];
  headline: HeadlineProjection;
}

/** Built-in derive rules matching DEFAULT_STATUSES (review rung = `review`). */
export const DEFAULT_DERIVE_CONFIG: DeriveConfig = {
  phaseLadder: [
    { phase: 'draft', when: '*', next: 'Fill in the objective and acceptance criteria' },
    {
      // planExists-but-not-approved also sits here: the default status set has
      // no `planning` id. Users who define one add a `planExists:true` rung.
      phase: 'ready_for_planning',
      when: 'hasRealObjective:true AND acRealTotal > 0',
      next: 'Write a plan and get it approved',
    },
    { phase: 'ready_to_implement', when: 'planApproved:true', next: 'Start implementing' },
    {
      phase: 'in_progress',
      when: 'planApproved:true AND implementationStarted:true',
      next: 'Finish acceptance criteria, then request review',
    },
    {
      phase: 'review',
      when: 'acAllChecked:true OR reviewRequested:true',
      next: 'Complete, or address review feedback',
    },
  ],
  disposition: [
    { when: 'parked:true', is: 'parked' },
    { when: 'blocked:true', is: 'blocked' },
    { when: null, is: 'active' },
  ],
  headline: { terminal: 'passthrough', parked: 'parked', blocked: 'blocked', active: 'phase' },
};

/**
 * Validate derive rules against a status config: rung/headline ids must be
 * defined statuses, disposition `is` values must be active|blocked|parked,
 * and every `when` must parse against the AQL field registry. Returns
 * human-readable problems (empty = valid). Used by doctor and the dashboard
 * settings API; pure so the dashboard client reuses it.
 *
 * The status param is intentionally minimal (`{ statuses: Array<{ id: string }> }`)
 * so this module stays dependency-free; it is structurally compatible with the
 * `Pick<StatusConfig, 'statuses'>` callers pass.
 */
export function validateDeriveConfig(
  derive: DeriveConfig,
  statusConfig: { statuses: Array<{ id: string }> },
  validateWhen: (when: string) => string | null = () => null,
): string[] {
  const problems: string[] = [];
  const ids = new Set(statusConfig.statuses.map((s) => s.id));

  if (derive.phaseLadder.length === 0) {
    problems.push('phaseLadder must have at least one rung');
  }
  for (const rung of derive.phaseLadder) {
    if (!ids.has(rung.phase)) {
      problems.push(`phaseLadder rung "${rung.phase}" is not a defined status id`);
    }
    const err = rung.when === '*' ? null : validateWhen(rung.when);
    if (err) problems.push(`phaseLadder rung "${rung.phase}": invalid condition — ${err}`);
  }
  const VALID_DISPOSITIONS = new Set(['active', 'blocked', 'parked']);
  let sawElse = false;
  for (const rule of derive.disposition) {
    if (!VALID_DISPOSITIONS.has(rule.is)) {
      problems.push(
        `disposition "${rule.is}" is not valid (expected active, blocked, or parked — terminal is never a rule)`,
      );
    }
    if (rule.when === null) sawElse = true;
    else {
      const err = validateWhen(rule.when);
      if (err) problems.push(`disposition rule "${rule.is}": invalid condition — ${err}`);
    }
  }
  if (!sawElse) problems.push('disposition rules must end with an `else:` arm');

  for (const key of ['parked', 'blocked'] as const) {
    if (!ids.has(derive.headline[key])) {
      problems.push(
        `headline.${key} → "${derive.headline[key]}" is not a defined status id (add the definition or run migrate-derive)`,
      );
    }
  }
  return problems;
}
