import { resolve, join } from 'node:path';
import { readdir, readFile, lstat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { fileExists } from '../../fs.js';
import { isSyntaurPluginEnabledFor } from '../../plugin-state.js';
import { KNOWN_SKILLS } from '../../install-skills.js';
import type { Check, CheckResult } from '../types.js';

const CATEGORY = 'skills';

const skillTargets: Array<{ agent: 'claude' | 'codex'; dir: string; label: string }> = [
  { agent: 'claude', dir: resolve(homedir(), '.claude', 'skills'), label: '~/.claude/skills' },
  { agent: 'codex', dir: resolve(homedir(), '.codex', 'skills'), label: '~/.codex/skills' },
];

const skillsDedupCheck: Check = {
  id: 'skills.dedup',
  category: CATEGORY,
  title: 'Syntaur skills are not duplicated across install paths',
  async run() {
    const findings: string[] = [];
    const affected: string[] = [];

    for (const { agent, dir, label } of skillTargets) {
      if (!(await fileExists(dir))) continue;

      const pluginEnabled = await isSyntaurPluginEnabledFor(agent);
      const present: { name: string; isSymlink: boolean }[] = [];
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const entry of entries) {
        if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
        if (!(KNOWN_SKILLS as readonly string[]).includes(entry.name)) continue;

        // Verify the SKILL.md is one of ours, so we don't false-positive on
        // a user-authored skill that happens to share a directory name.
        const skillMd = join(dir, entry.name, 'SKILL.md');
        if (!(await fileExists(skillMd))) continue;
        const content = await readFile(skillMd, 'utf-8').catch(() => '');
        const match = content.match(/^name:\s*(\S+)\s*$/m);
        if (!match || match[1] !== entry.name) continue;

        let isSymlink = false;
        try {
          isSymlink = (await lstat(join(dir, entry.name))).isSymbolicLink();
        } catch {}

        present.push({ name: entry.name, isSymlink });
      }

      if (present.length === 0) continue;

      if (pluginEnabled) {
        const nonSymlink = present.filter((p) => !p.isSymlink);
        if (nonSymlink.length > 0) {
          findings.push(
            `${label}: ${nonSymlink.length} syntaur skill(s) installed globally while the syntaur plugin is enabled (${agent}) — duplicate registrations`,
          );
          for (const p of nonSymlink) affected.push(join(dir, p.name));
        }
      }
    }

    if (findings.length === 0) {
      return {
        id: this.id,
        category: this.category,
        title: this.title,
        status: 'pass',
        autoFixable: false,
      } satisfies CheckResult;
    }

    return {
      id: this.id,
      category: this.category,
      title: this.title,
      status: 'warn',
      detail: findings.join('; '),
      affected,
      remediation: {
        kind: 'manual',
        suggestion:
          'Either disable the plugin or remove the global skill copies. Recommended: keep the plugin path and remove the global copies via `syntaur uninstall --skills` (preserves user-authored skills with non-syntaur frontmatter).',
        command: null,
      },
      autoFixable: false,
    } satisfies CheckResult;
  },
};

export const skillsChecks: Check[] = [skillsDedupCheck];
