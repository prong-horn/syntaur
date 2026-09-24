import { resolve } from 'node:path';
import {
  defaultCleanupDeps,
  detectLeftovers,
  isActionableLeftover,
} from '../../../commands/migrate-cleanup.js';
import type { Check, CheckResult } from '../types.js';

const CATEGORY = 'structure';

const legacyLeftovers: Check = {
  id: 'structure.legacy-leftovers',
  category: CATEGORY,
  title: 'No pre-v2 install leftovers on this machine',
  async run(ctx) {
    const deps = {
      ...defaultCleanupDeps(),
      syntaurHome: ctx.syntaurRoot,
    };
    const leftovers = await detectLeftovers(deps);
    const warnItems = leftovers.filter((l) => isActionableLeftover(l));
    if (warnItems.length === 0) {
      return pass(this);
    }

    const byCategory = new Map<string, number>();
    for (const item of warnItems) {
      byCategory.set(item.category, (byCategory.get(item.category) ?? 0) + 1);
    }
    const detailParts = [...byCategory.entries()].map(([k, n]) => `${k}: ${n}`);

    const blocked = warnItems.filter((l) => l.kind === 'blocked');
    let detail = `${warnItems.length} leftover(s) (${detailParts.join(', ')})`;
    if (blocked.length > 0) {
      const blockedLines = blocked.slice(0, 5).map((l) => `${l.path}: ${l.detail}`);
      let suffix = blockedLines.join('; ');
      if (blocked.length > 5) {
        suffix += `; … and ${blocked.length - 5} more`;
      }
      detail += `. Blocked: ${suffix}`;
    }

    const affectedPaths = warnItems.map((l) => l.path);
    const affected = affectedPaths.slice(0, 10);
    if (blocked.length > 0) {
      for (const item of blocked) {
        if (affected.length >= 10) break;
        if (!affected.includes(item.path)) affected.push(item.path);
      }
    }

    return {
      id: this.id,
      category: this.category,
      title: this.title,
      status: 'warn',
      detail,
      affected,
      remediation: {
        kind: 'manual',
        suggestion: 'Retire detected leftovers reversibly',
        command: 'syntaur migrate cleanup --apply',
      },
      autoFixable: false,
    } satisfies CheckResult;
  },
};

function pass(check: { id: string; category: string; title: string }): CheckResult {
  return {
    id: check.id,
    category: check.category,
    title: check.title,
    status: 'pass',
    autoFixable: false,
  };
}

export const legacyLeftoverChecks: Check[] = [legacyLeftovers];
