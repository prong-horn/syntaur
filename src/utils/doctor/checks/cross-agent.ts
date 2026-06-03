import { join, resolve } from 'node:path';
import { fileExists } from '../../fs.js';
import { KNOWN_SKILLS } from '../../install-skills.js';
import { AGENT_TARGETS } from '../../../targets/registry.js';
import type { Check, CheckResult } from '../types.js';

const CATEGORY = 'cross-agent';

/** Count how many known Syntaur skills are present (by SKILL.md) in a dir. */
async function countSyntaurSkills(dir: string): Promise<number> {
  if (!(await fileExists(dir))) return 0;
  let n = 0;
  for (const skill of KNOWN_SKILLS) {
    if (await fileExists(join(dir, skill, 'SKILL.md'))) n++;
  }
  return n;
}

const crossAgentSkillsCheck: Check = {
  id: 'cross-agent.skills',
  category: CATEGORY,
  title: 'Cross-agent targets have Syntaur skills + protocol files',
  async run(ctx) {
    const installed = ctx.config.integrations.installedAgents ?? {};
    const total = KNOWN_SKILLS.length;
    const lines: string[] = [];
    const problems: string[] = [];
    const affected: string[] = [];
    let considered = 0;

    for (const t of AGENT_TARGETS) {
      // CC/Codex skills are covered by their own plugin + skills checks.
      if (t.nativePlugin) continue;
      const dir = t.skillsDir?.global;
      if (!dir) continue;

      const recorded = Boolean(installed[t.id]);
      const detected = await t.detect();
      if (!recorded && !detected) continue;

      considered++;
      const present = await countSyntaurSkills(dir);
      lines.push(`${t.displayName}: ${present}/${total} skills (${dir})`);

      // Only escalate to a problem for agents the user recorded installing —
      // a merely-detected agent the user never targeted shouldn't warn.
      if (recorded && present < total) {
        problems.push(
          `${t.displayName}: ${present === 0 ? 'no Syntaur skills' : `incomplete skills (${present}/${total})`}`,
        );
        affected.push(dir);
      }

      // Tier-2 adapter files are workspace-local; check against the cwd.
      if (recorded && t.instructions) {
        for (const f of t.instructions.files) {
          const p = resolve(ctx.cwd, f.path);
          if (!(await fileExists(p))) {
            problems.push(`${t.displayName}: missing protocol file ${f.path} in cwd`);
            affected.push(p);
          }
        }
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

    if (problems.length > 0) {
      return {
        id: this.id,
        category: this.category,
        title: this.title,
        status: 'warn',
        detail: `${problems.join('; ')}. (${lines.join('; ')})`,
        affected,
        remediation: {
          kind: 'manual',
          suggestion:
            'Re-run `syntaur setup --target <id>` (from the assignment workspace, to also write protocol files) to complete the install.',
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
