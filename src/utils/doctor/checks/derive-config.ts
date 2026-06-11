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
    const statuses = ctx.config.statuses;
    const rawFacts = statuses?.facts ?? null;
    const derive = statuses?.derive ?? null;

    if (!statuses || ((!rawFacts || rawFacts.length === 0) && !derive)) {
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
    if (rawFacts && rawFacts.length > 0) {
      problems.push(...validateFactDeclarations(rawFacts));
    }
    if (derive) {
      // Build the dynamic registry from the ACCEPTED declarations so derive
      // conditions referencing declared fact names pass, undeclared still fail.
      const accepted = acceptFactDeclarations(normalizeFactDeclarations(rawFacts));
      const registry = buildDeriveRegistry(accepted);
      problems.push(
        ...validateDeriveConfig(derive, statuses, (when) => validateDeriveCondition(when, registry)),
      );
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
