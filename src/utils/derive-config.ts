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
      // Rework (a new `implement` stage after `review`) must leave review even
      // when ACs stay checked — hence `AND NOT reworkRequested` (stage-fact-status-bridge).
      when: '(acAllChecked:true OR reviewRequested:true) AND NOT reworkRequested:true',
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
/**
 * Deeply shape-check an UNTRUSTED derive payload (from the dashboard POST body)
 * before {@link validateDeriveConfig} runs. validateDeriveConfig assumes every
 * rung/rule/field already has its declared type, so a malformed payload (a null
 * rung, a numeric `when`, …) would otherwise throw a 500 — and worse, slip
 * through to serialization after assignment files were already mutated. This
 * returns human-readable problems (empty = structurally sound) so the API can
 * reject with `invalid-derive` 400 before touching disk.
 */
export function validateDeriveShape(value: unknown): string[] {
  const problems: string[] = [];
  if (!value || typeof value !== 'object') {
    return ['derive must be an object'];
  }
  const d = value as Record<string, unknown>;

  if (!Array.isArray(d.phaseLadder)) {
    problems.push('derive.phaseLadder must be an array');
  } else {
    d.phaseLadder.forEach((rung, i) => {
      if (!rung || typeof rung !== 'object') {
        problems.push(`derive.phaseLadder[${i}] must be an object`);
        return;
      }
      const r = rung as Record<string, unknown>;
      if (typeof r.phase !== 'string') problems.push(`derive.phaseLadder[${i}].phase must be a string`);
      if (typeof r.when !== 'string') problems.push(`derive.phaseLadder[${i}].when must be a string`);
      if (r.next !== undefined && typeof r.next !== 'string') {
        problems.push(`derive.phaseLadder[${i}].next must be a string when present`);
      }
    });
  }

  if (!Array.isArray(d.disposition)) {
    problems.push('derive.disposition must be an array');
  } else {
    d.disposition.forEach((rule, i) => {
      if (!rule || typeof rule !== 'object') {
        problems.push(`derive.disposition[${i}] must be an object`);
        return;
      }
      const r = rule as Record<string, unknown>;
      if (!(r.when === null || typeof r.when === 'string')) {
        problems.push(`derive.disposition[${i}].when must be a string or null`);
      }
      if (typeof r.is !== 'string') problems.push(`derive.disposition[${i}].is must be a string`);
    });
  }

  const headline = d.headline as Record<string, unknown> | undefined;
  if (!headline || typeof headline !== 'object') {
    problems.push('derive.headline must be an object');
  } else {
    if (typeof headline.parked !== 'string') problems.push('derive.headline.parked must be a string');
    if (typeof headline.blocked !== 'string') problems.push('derive.headline.blocked must be a string');
  }

  return problems;
}

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
  for (const rule of derive.disposition) {
    if (!VALID_DISPOSITIONS.has(rule.is)) {
      problems.push(
        `disposition "${rule.is}" is not valid (expected active, blocked, or parked — terminal is never a rule)`,
      );
    }
    if (rule.when !== null) {
      const err = validateWhen(rule.when);
      if (err) problems.push(`disposition rule "${rule.is}": invalid condition — ${err}`);
    }
  }
  // Disposition is first-match-wins, so the `else:` arm (when: null) must be the
  // SINGLE last rule — an else-first (or duplicate-else) config silently makes
  // every later rule unreachable.
  const elseIndices = derive.disposition
    .map((r, i) => (r.when === null ? i : -1))
    .filter((i) => i >= 0);
  if (elseIndices.length === 0) {
    problems.push('disposition rules must end with an `else:` arm (a rule with when: null)');
  } else if (elseIndices.length > 1) {
    problems.push('disposition rules must have exactly one `else:` arm (when: null)');
  } else if (elseIndices[0] !== derive.disposition.length - 1) {
    problems.push('the `else:` arm (when: null) must be the LAST disposition rule — rules after it are unreachable');
  }

  for (const key of ['parked', 'blocked'] as const) {
    if (!ids.has(derive.headline[key])) {
      problems.push(
        `headline.${key} → "${derive.headline[key]}" is not a defined status id (add the definition or run migrate-derive)`,
      );
    }
  }
  return problems;
}
