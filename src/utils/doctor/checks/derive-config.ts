/**
 * Doctor check: validate custom fact declarations and derive rules in
 * config.md (derived-status v3 + custom facts). This is the FIRST production
 * call site of `validateDeriveConfig` (previously test-only) — it surfaces a
 * misconfigured `statuses.facts` / phase ladder proactively instead of only at
 * recompute time. Reports each problem as an error; never hard-fails config
 * load (a bad rung must not brick unrelated commands).
 *
 * Validation is split so a config with facts but `derive: null` still validates:
 *  - facts present              → validateFactDeclarations(raw rows)
 *  - facts + derive rules       → validateDeriveConfig with a registry-aware
 *                                 validateWhen (declared fact names accepted)
 *  - derive rules, no facts     → validateDeriveConfig with the base registry
 */

import {
  normalizeFactDeclarations,
  validateDeriveConfig,
  validateFactDeclarations,
} from '../../config.js';
import { getWorkflowLibrary } from '../../workflow-resolve.js';
import {
  acceptFactDeclarations,
  buildDeriveRegistry,
  validateDeriveCondition,
} from '../../../lifecycle/derive.js';
import type { Check, CheckResult } from '../types.js';

const CATEGORY = 'derive-config';

const deriveConfigValid: Check = {
  id: 'derive-config.valid',
  category: CATEGORY,
  title: 'Custom fact declarations and derive rules are valid',
  async run(ctx): Promise<CheckResult> {
    // Validate EVERY workflow bundle in the library (legacy single-config reads
    // as `{ default: <statuses> }`), so a misconfigured phase ladder / facts in
    // ANY workflow is surfaced — each problem labeled by workflow id.
    const library = getWorkflowLibrary(ctx.config);
    const entries = Object.entries(library);
    const multi = entries.length > 1;
    const toCheck = entries.filter(
      ([, wf]) => (wf.facts && wf.facts.length > 0) || wf.derive,
    );

    if (toCheck.length === 0) {
      return {
        id: this.id,
        category: this.category,
        title: this.title,
        status: 'skipped',
        detail: 'no custom facts or derive rules configured',
        autoFixable: false,
      };
    }

    const problems: string[] = [];
    for (const [id, wf] of toCheck) {
      const label = multi ? `[workflow ${id}] ` : '';
      const rawFacts = wf.facts ?? null;
      if (rawFacts && rawFacts.length > 0) {
        for (const p of validateFactDeclarations(rawFacts)) problems.push(`${label}${p}`);
      }
      if (wf.derive) {
        // Build the dynamic registry from THIS workflow's ACCEPTED declarations so
        // its derive conditions referencing declared fact names pass, undeclared
        // still fail. `wf` is a StatusConfig (definitions) for status-id checks.
        const accepted = acceptFactDeclarations(normalizeFactDeclarations(rawFacts));
        const registry = buildDeriveRegistry(accepted);
        for (const p of validateDeriveConfig(wf.derive, wf, (when) =>
          validateDeriveCondition(when, registry),
        )) {
          problems.push(`${label}${p}`);
        }
      }
    }

    if (problems.length === 0) {
      return {
        id: this.id,
        category: this.category,
        title: this.title,
        status: 'pass',
        detail: 'fact declarations and derive rules are valid',
        autoFixable: false,
      };
    }

    return {
      id: this.id,
      category: this.category,
      title: this.title,
      status: 'error',
      detail: problems.join('; '),
      affected: problems,
      remediation: {
        kind: 'manual',
        suggestion:
          'Fix the flagged fact declarations / derive conditions in ~/.syntaur/config.md (statuses.facts, phaseLadder, disposition).',
        command: null,
      },
      autoFixable: false,
    };
  },
};

export const deriveConfigChecks: Check[] = [deriveConfigValid];
