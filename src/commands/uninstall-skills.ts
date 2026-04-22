import { uninstallSkills } from '../utils/install-skills.js';

export interface UninstallSkillsOptions {
  claude?: boolean;
  codex?: boolean;
  all?: boolean;
}

export async function uninstallSkillsCommand(
  options: UninstallSkillsOptions,
): Promise<void> {
  const runClaude = Boolean(options.claude || options.all);
  const runCodex = Boolean(options.codex || options.all);

  if (!runClaude && !runCodex) {
    throw new Error(
      'Specify --claude, --codex, or --all (use one or more).',
    );
  }

  let totalRemoved = 0;

  if (runClaude) {
    const removed = await uninstallSkills({ target: 'claude' });
    totalRemoved += removed.length;
    console.log(
      `Removed ${removed.length} Syntaur protocol skill(s) from ~/.claude/skills:`,
    );
    for (const p of removed) console.log(`  - ${p}`);
  }

  if (runCodex) {
    const removed = await uninstallSkills({ target: 'codex' });
    totalRemoved += removed.length;
    console.log(
      `Removed ${removed.length} Syntaur protocol skill(s) from ~/.codex/skills:`,
    );
    for (const p of removed) console.log(`  - ${p}`);
  }

  if (totalRemoved === 0) {
    console.log(
      'No Syntaur protocol skills found to remove. (User-authored skills with matching directory names are preserved.)',
    );
  }
}
