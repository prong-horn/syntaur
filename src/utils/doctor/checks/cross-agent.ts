import { join, resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileExists } from '../../fs.js';
import { KNOWN_SKILLS, getSkillsDir, discoverSkillNames } from '../../install-skills.js';
import { readSkillIdentity, sha256File } from '../../skill-frontmatter.js';
import { resolveAgentTargets } from '../../../targets/registry.js';
import type { Check, CheckResult } from '../types.js';

const CATEGORY = 'cross-agent';

export type SkillProblemKind = 'missing' | 'invalid-frontmatter' | 'content-drift';

export interface SkillIntegrityProblem {
  skill: string;
  kind: SkillProblemKind;
}

export interface TargetIntegrity {
  /** Skills present with valid frontmatter (the "good" count). */
  valid: number;
  /** Total skills considered (KNOWN_SKILLS length). */
  total: number;
  problems: SkillIntegrityProblem[];
}

/**
 * Classify each known skill installed under `installedDir` against the canonical
 * `skills/` tree. Pure (given two dirs) → unit-testable with temp dirs.
 *
 *  - missing             — no `<skill>/SKILL.md` in the agent dir
 *  - invalid-frontmatter — SKILL.md unreadable / no frontmatter / `name` absent
 *                          or != skill / no non-empty `description`
 *  - content-drift       — valid but sha256 differs from canonical (stale install)
 */
export async function checkTargetSkillsIntegrity(
  installedDir: string,
  canonicalSkillsDir: string,
  knownSkills: readonly string[] = KNOWN_SKILLS,
): Promise<TargetIntegrity> {
  const problems: SkillIntegrityProblem[] = [];
  let valid = 0;

  for (const skill of knownSkills) {
    const installedPath = join(installedDir, skill, 'SKILL.md');
    if (!(await fileExists(installedPath))) {
      problems.push({ skill, kind: 'missing' });
      continue;
    }

    let text: string;
    try {
      text = await readFile(installedPath, 'utf-8');
    } catch {
      problems.push({ skill, kind: 'invalid-frontmatter' });
      continue;
    }

    const { name, hasDescription } = readSkillIdentity(text);
    if (name !== skill || !hasDescription) {
      problems.push({ skill, kind: 'invalid-frontmatter' });
      continue;
    }

    valid++;

    // Content drift vs the canonical skill (only when the canonical file exists).
    const canonicalPath = join(canonicalSkillsDir, skill, 'SKILL.md');
    if (await fileExists(canonicalPath)) {
      const [installedHash, canonicalHash] = await Promise.all([
        sha256File(installedPath),
        sha256File(canonicalPath),
      ]);
      if (installedHash !== canonicalHash) {
        problems.push({ skill, kind: 'content-drift' });
      }
    }
  }

  return { valid, total: knownSkills.length, problems };
}

/** Human summary like `2 missing, 1 invalid frontmatter`. */
export function summarizeProblems(problems: SkillIntegrityProblem[]): string[] {
  const counts: Record<SkillProblemKind, number> = {
    missing: 0,
    'invalid-frontmatter': 0,
    'content-drift': 0,
  };
  for (const p of problems) counts[p.kind]++;
  const parts: string[] = [];
  if (counts.missing) parts.push(`${counts.missing} missing`);
  if (counts['invalid-frontmatter'])
    parts.push(`${counts['invalid-frontmatter']} invalid frontmatter`);
  if (counts['content-drift']) parts.push(`${counts['content-drift']} content drift`);
  return parts;
}

const crossAgentSkillsCheck: Check = {
  id: 'cross-agent.skills',
  category: CATEGORY,
  title: 'Cross-agent targets have Syntaur skills + protocol files',
  async run(ctx) {
    const installed = ctx.config.integrations.installedAgents ?? {};
    // Merge built-in targets with validated user descriptors; descriptor load
    // warnings are surfaced (see below) so a malformed file is never silent.
    const { targets: resolvedTargets, warnings: descriptorWarnings } =
      await resolveAgentTargets();
    const canonicalSkillsDir = await getSkillsDir();
    // Derive the expected skill set from the canonical tree (the same set the
    // cross-agent install actually copies — `discoverSkillNames`), NOT the
    // hand-pinned KNOWN_SKILLS, which lags behind newly-added skills (e.g. the
    // bundle-* skills) and would let them silently escape integrity checks.
    let knownSkills: readonly string[];
    try {
      const discovered = await discoverSkillNames(canonicalSkillsDir);
      knownSkills = discovered.length > 0 ? discovered : KNOWN_SKILLS;
    } catch {
      knownSkills = KNOWN_SKILLS;
    }
    const total = knownSkills.length;
    const lines: string[] = [];
    const problems: string[] = [];
    const affected: string[] = [];
    let considered = 0;

    for (const t of resolvedTargets) {
      // CC/Codex skills are covered by their own plugin + skills checks.
      if (t.nativePlugin) continue;
      const dir = t.skillsDir?.global;
      if (!dir) continue;

      const recorded = Boolean(installed[t.id]);
      const detected = await t.detect();
      if (!recorded && !detected) continue;

      considered++;
      const integrity = await checkTargetSkillsIntegrity(dir, canonicalSkillsDir, knownSkills);
      const summary = summarizeProblems(integrity.problems);
      lines.push(
        `${t.displayName}: ${integrity.valid}/${total} valid` +
          (summary.length ? ` (${summary.join(', ')})` : '') +
          ` (${dir})`,
      );

      // Only escalate to a problem for agents the user recorded installing —
      // a merely-detected agent the user never targeted shouldn't warn.
      if (recorded && integrity.problems.length > 0) {
        problems.push(`${t.displayName}: ${summary.join(', ')}`);
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

      // Tier-3 deep-enforcement plugin status (pi/OpenClaw/Hermes). Additive:
      // report installed/absent; warn only for agents the user recorded.
      if (t.tier3) {
        const installDir = t.tier3.installDir();
        const installed = await fileExists(join(installDir, t.tier3.entry));
        lines.push(
          `${t.displayName}: Tier-3 ${t.tier3.kind} ${installed ? 'installed' : 'absent'} (${installDir})`,
        );
        if (recorded && !installed) {
          problems.push(`${t.displayName}: Tier-3 ${t.tier3.kind} not installed`);
          affected.push(installDir);
        }
      }
    }

    // Surface user-descriptor load warnings even when nothing else is checked —
    // otherwise a malformed `~/.syntaur/targets/*.json` would be swallowed by the
    // `considered === 0` skipped path.
    if (considered === 0) {
      if (descriptorWarnings.length > 0) {
        return {
          id: this.id,
          category: this.category,
          title: this.title,
          status: 'warn',
          detail: `User target descriptor issues: ${descriptorWarnings.join('; ')}`,
          remediation: {
            kind: 'manual',
            suggestion: `Fix or remove the offending file(s) in ~/.syntaur/targets/ (see references/user-targets.md).`,
            command: null,
          },
          autoFixable: false,
        } satisfies CheckResult;
      }
      return {
        id: this.id,
        category: this.category,
        title: this.title,
        status: 'skipped',
        detail: 'No cross-agent targets detected or recorded.',
        autoFixable: false,
      } satisfies CheckResult;
    }

    // Descriptor warnings escalate the check when targets WERE considered.
    for (const w of descriptorWarnings) problems.push(`user target descriptor: ${w}`);

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
            'Re-run `syntaur setup --target <id>` (from the assignment workspace, to also write protocol files) to complete or refresh the install.',
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
