/**
 * Doctor check: validate the optional `staleness:` block in config.md (per-reason
 * age-gate overrides for the needs-attention classifier). The config parser fails
 * safe — it silently drops unknown keys / unparseable durations and falls back to
 * the default gate — so this check surfaces those mistakes proactively instead of
 * letting a typo quietly do nothing. Never hard-fails config load.
 */

import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { validateStalenessConfig } from '../../config.js';
import type { Check, CheckResult } from '../types.js';

const CATEGORY = 'staleness';

const stalenessConfigValid: Check = {
  id: 'staleness.valid',
  category: CATEGORY,
  title: 'Staleness threshold overrides are valid',
  async run(ctx): Promise<CheckResult> {
    let content: string;
    try {
      content = await readFile(resolve(ctx.syntaurRoot, 'config.md'), 'utf-8');
    } catch {
      return {
        id: this.id,
        category: this.category,
        title: this.title,
        status: 'skipped',
        detail: 'no config.md',
        autoFixable: false,
      };
    }

    if (!/^\s*staleness:\s*$/m.test(content)) {
      return {
        id: this.id,
        category: this.category,
        title: this.title,
        status: 'skipped',
        detail: 'no staleness: block configured (using defaults)',
        autoFixable: false,
      };
    }

    const problems = validateStalenessConfig(content);
    if (problems.length === 0) {
      return {
        id: this.id,
        category: this.category,
        title: this.title,
        status: 'pass',
        detail: 'staleness threshold overrides are valid',
        autoFixable: false,
      };
    }

    return {
      id: this.id,
      category: this.category,
      title: this.title,
      status: 'warn',
      detail: problems.join('; '),
      affected: problems,
      remediation: {
        kind: 'manual',
        suggestion:
          'Fix the flagged staleness: entries in ~/.syntaur/config.md. Each value must be a positive duration (7d, 12h, 30m, 90s, 500ms). Invalid entries are ignored and fall back to the default gate.',
        command: null,
      },
      autoFixable: false,
    };
  },
};

export const stalenessChecks: Check[] = [stalenessConfigValid];
