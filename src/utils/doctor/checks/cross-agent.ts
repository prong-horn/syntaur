import { join } from 'node:path';
import { fileExists } from '../../fs.js';
import { KNOWN_SKILLS } from '../../install-skills.js';
import { AGENT_TARGETS } from '../../../targets/registry.js';
import type { Check, CheckResult } from '../types.js';

const CATEGORY = 'cross-agent';

/** A target "has" Syntaur skills if at least one known skill dir with a matching SKILL.md is present. */
async function hasSyntaurSkills(dir: string): Promise<boolean> {
  if (!(await fileExists(dir))) return false;
  for (const skill of KNOWN_SKILLS) {
    if (await fileExists(join(dir, skill, 'SKILL.md'))) return true;
  }
  return false;
}

const crossAgentSkillsCheck: Check = {
  id: 'cross-agent.skills',
  category: CATEGORY,
  title: 'Cross-agent targets have Syntaur skills installed',
  async run(ctx) {
    const installed = ctx.config.integrations.installedAgents ?? {};
    const lines: string[] = [];
    const affected: string[] = [];
    const missingRecorded: string[] = [];
    let considered = 0;

    for (const t of AGENT_TARGETS) {
      // CC/Codex skills are covered by their own plugin + skills checks.
      if (t.nativePlugin) continue;
      const dir = t.skillsDir?.global;
      if (!dir) continue;

      const detected = await t.detect();
      const recorded = Boolean(installed[t.id]);
      if (!detected && !recorded) continue;

      considered++;
      const has = await hasSyntaurSkills(dir);
      lines.push(`${t.displayName}: ${has ? 'skills present' : 'no syntaur skills'} (${dir})`);
      if (recorded && !has) {
        missingRecorded.push(t.displayName);
        affected.push(dir);
      }
    }

    if (considered === 0) {
      return {
        id: this.id,
        category: this.category,
        title: this.title,
        status: 'skipped',
        detail: 'No cross-agent targets detected or recorded.',
        autoFixable: false,
      } satisfies CheckResult;
    }

    if (missingRecorded.length > 0) {
      return {
        id: this.id,
        category: this.category,
        title: this.title,
        status: 'warn',
        detail: `Recorded install but skills missing for: ${missingRecorded.join(', ')}. ${lines.join('; ')}`,
        affected,
        remediation: {
          kind: 'manual',
          suggestion:
            'Re-run `syntaur setup --target <id>` to (re)install skills for that agent.',
          command: null,
        },
        autoFixable: false,
      } satisfies CheckResult;
    }

    return {
      id: this.id,
      category: this.category,
      title: this.title,
      status: 'pass',
      detail: lines.join('; '),
      autoFixable: false,
    } satisfies CheckResult;
  },
};

export const crossAgentChecks: Check[] = [crossAgentSkillsCheck];
