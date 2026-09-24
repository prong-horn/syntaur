import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { fileExists } from '../../fs.js';
import {
  fileSha256,
  hooksDirForInstallRoot,
  isOurHookCommand,
  listPackageHookScripts,
} from '../../../commands/hooks.js';
import { isSyntaurPluginKey } from '../../claude-plugin-key.js';
import type { Check, CheckResult } from '../types.js';

const CATEGORY = 'hooks';

interface ClaudeSettingsFile {
  enabledPlugins?: Record<string, boolean | unknown>;
  hooks?: Record<string, Array<{ hooks?: Array<{ command?: string }> }>>;
}

function syntaurPluginEnabled(settings: ClaudeSettingsFile | null): boolean {
  const enabled = settings?.enabledPlugins ?? {};
  for (const [key, value] of Object.entries(enabled)) {
    if (value !== true) continue;
    if (isSyntaurPluginKey(key)) return true;
  }
  return false;
}

function collectOurHookCommands(
  settings: ClaudeSettingsFile,
  installedHooksDir: string,
): string[] {
  const commands: string[] = [];
  const hooks = settings.hooks ?? {};
  for (const groups of Object.values(hooks)) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      for (const h of group.hooks ?? []) {
        if (typeof h.command === 'string' && isOurHookCommand(h.command, installedHooksDir)) {
          commands.push(h.command);
        }
      }
    }
  }
  return commands;
}

function scriptPathFromCommand(command: string): string | null {
  const m = command.match(/^bash\s+(\S+)$/);
  return m ? m[1] : null;
}

const hooksInstalledCheck: Check = {
  id: 'hooks.installed',
  category: CATEGORY,
  title: 'Syntaur session hooks are installed in Claude Code settings',
  async run(ctx) {
    const claudeDir = resolve(homedir(), '.claude');
    if (!(await fileExists(claudeDir))) {
      return skip(this, 'Claude Code config directory not found');
    }

    const settingsPath = resolve(claudeDir, 'settings.json');
    const installedHooksDir = hooksDirForInstallRoot(ctx.syntaurRoot);

    let settings: ClaudeSettingsFile | null = null;
    if (await fileExists(settingsPath)) {
      try {
        const raw = await readFile(settingsPath, 'utf-8');
        settings = JSON.parse(raw) as ClaudeSettingsFile;
      } catch {
        settings = null;
      }
    }

    const ourCommands = settings ? collectOurHookCommands(settings, installedHooksDir) : [];

    if (ourCommands.length === 0) {
      return {
        id: this.id,
        category: this.category,
        title: this.title,
        status: 'warn',
        detail: 'not installed — run `syntaur hooks install`',
        remediation: {
          kind: 'manual',
          suggestion: 'Run `syntaur hooks install` to wire SessionStart, PostToolUse, and UserPromptSubmit hooks',
          command: 'syntaur hooks install',
        },
        autoFixable: false,
      } satisfies CheckResult;
    }

    if (settings && syntaurPluginEnabled(settings)) {
      return {
        id: this.id,
        category: this.category,
        title: this.title,
        status: 'warn',
        detail:
          'the syntaur plugin is still enabled (`enabledPlugins` key `syntaur@…`); it registers the same hooks — remove it',
        remediation: {
          kind: 'manual',
          suggestion:
            'Disable the syntaur plugin in ~/.claude/settings.json enabledPlugins and remove the marketplace plugin copy',
          command: null,
        },
        autoFixable: false,
      } satisfies CheckResult;
    }

    const packageScripts = await listPackageHookScripts();
    const packageHashes = new Map<string, string>();
    for (const p of packageScripts) {
      packageHashes.set(p.split('/').pop()!, await fileSha256(p));
    }

    const drift: string[] = [];
    for (const cmd of ourCommands) {
      const scriptPath = scriptPathFromCommand(cmd);
      if (!scriptPath) {
        drift.push(`unparseable hook command: ${cmd}`);
        continue;
      }
      if (!(await fileExists(scriptPath))) {
        drift.push(`missing installed script: ${scriptPath}`);
        continue;
      }
      const base = scriptPath.split('/').pop()!;
      const pkgHash = packageHashes.get(base);
      if (!pkgHash) continue;
      const installedHash = await fileSha256(scriptPath);
      if (installedHash !== pkgHash) {
        drift.push(`${base} differs from the package copy`);
      }
    }

    if (drift.length > 0) {
      return {
        id: this.id,
        category: this.category,
        title: this.title,
        status: 'warn',
        detail: `drift — re-run \`syntaur hooks install\` (${drift.join('; ')})`,
        remediation: {
          kind: 'manual',
          suggestion: 'Run `syntaur hooks install` to refresh hook scripts and settings entries',
          command: 'syntaur hooks install',
        },
        autoFixable: false,
      } satisfies CheckResult;
    }

    return pass(this);
  },
};

export const hooksChecks: Check[] = [hooksInstalledCheck];

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
