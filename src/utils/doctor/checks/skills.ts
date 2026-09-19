import { resolve, join } from 'node:path';
import { lstat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { fileExists } from '../../fs.js';
import type { Check, CheckResult } from '../types.js';

const CATEGORY = 'skills';

export const SYNTAUR_PACK_SKILL_NAMES = [
  'syntaur-protocol',
  'grab',
  'plan',
  'done',
  'log',
  'worktree',
] as const;

const skillsInstalledCheck: Check = {
  id: 'skills.installed',
  category: CATEGORY,
  title: 'Syntaur six-skill pack is installed for Claude Code',
  async run() {
    const claudeDir = resolve(homedir(), '.claude');
    if (!(await fileExists(claudeDir))) {
      return skip(this, 'Claude Code config directory not found');
    }

    const skillsDir = resolve(claudeDir, 'skills');
    const missing: string[] = [];

    for (const name of SYNTAUR_PACK_SKILL_NAMES) {
      const skillPath = join(skillsDir, name);
      if (!(await fileExists(join(skillPath, 'SKILL.md')))) {
        missing.push(name);
        continue;
      }
      try {
        const st = await lstat(skillPath);
        if (!st.isDirectory() && !st.isSymbolicLink()) {
          missing.push(name);
        }
      } catch {
        missing.push(name);
      }
    }

    if (missing.length > 0) {
      return {
        id: this.id,
        category: this.category,
        title: this.title,
        status: 'warn',
        detail: `missing under ~/.claude/skills/: ${missing.join(', ')}`,
        remediation: {
          kind: 'manual',
          suggestion: 'Install the pack with `npx skills add prong-horn/syntaur -g -a claude-code`',
          command: 'npx skills add prong-horn/syntaur -g -a claude-code',
        },
        autoFixable: false,
      } satisfies CheckResult;
    }

    return pass(this);
  },
};

export const skillsChecks: Check[] = [skillsInstalledCheck];

function pass(check: { id: string; category: string; title: string }): CheckResult {
  return {
    id: check.id,
    category: check.category,
    title: check.title,
    status: 'pass',
    autoFixable: false,
  };
}

function skip(
  check: { id: string; category: string; title: string },
  reason: string,
): CheckResult {
  return {
    id: check.id,
    category: check.category,
    title: check.title,
    status: 'skipped',
    detail: reason,
    autoFixable: false,
  };
}
