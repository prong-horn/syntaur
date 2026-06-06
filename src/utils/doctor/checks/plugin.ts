import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Check, CheckResult } from '../types.js';
import {
  readManagedInstallVersion,
  getPluginInstallCommand,
  getPluginDisplayName,
  type PluginKind,
} from '../../install.js';

const CATEGORY = 'plugin';
const PLUGIN_KINDS: PluginKind[] = ['claude', 'codex'];

/**
 * Read the running CLI's version by walking up from this module to the nearest
 * package.json. (`src/utils/version.ts`'s `readPackageVersion` only ascends two
 * dirs, which from `src/utils/doctor/checks/` lands on the wrong directory.)
 */
async function readCliVersion(): Promise<string | null> {
  try {
    let dir = dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 8; i += 1) {
      try {
        const parsed = JSON.parse(await readFile(join(dir, 'package.json'), 'utf-8')) as { version?: unknown };
        if (typeof parsed.version === 'string' && parsed.version.length > 0) return parsed.version;
      } catch {
        // ascend
      }
      dir = dirname(dir);
    }
  } catch {
    // fall through
  }
  return null;
}

/**
 * Warn when an installed (copy-mode) plugin's recorded version differs from the
 * running CLI — i.e. the user updated the CLI via npm but the marketplace plugin
 * copy is stale. The CLI is always fresh (npm), so it is the source of truth.
 * Skips when there is no managed install (incl. link installs, which write no
 * marker and are always fresh via the symlink).
 */
const versionDrift: Check = {
  id: 'plugin.version-drift',
  category: CATEGORY,
  title: 'Installed plugin matches the CLI version',
  async run(): Promise<CheckResult> {
    const base = { id: this.id, category: this.category, title: this.title, autoFixable: false } as const;

    const installed: Array<{ kind: PluginKind; label: string; version: string }> = [];
    for (const kind of PLUGIN_KINDS) {
      const version = await readManagedInstallVersion(kind);
      if (version !== null) installed.push({ kind, label: getPluginDisplayName(kind), version });
    }

    if (installed.length === 0) {
      return { ...base, status: 'skipped', detail: 'no managed plugin install detected' };
    }

    const cliVersion = await readCliVersion();
    if (!cliVersion) {
      return { ...base, status: 'skipped', detail: 'could not read the running CLI version' };
    }

    const drifted = installed.filter((p) => p.version !== cliVersion);
    if (drifted.length === 0) {
      const versions = installed.map((p) => `${p.label} ${p.version}`).join(', ');
      return { ...base, status: 'pass', detail: `${versions} matches CLI ${cliVersion}` };
    }

    const commands = drifted.map((p) => `${getPluginInstallCommand(p.kind)} --force`);
    const detail = `${drifted.map((p) => `${p.label} v${p.version}`).join(', ')} differs from CLI v${cliVersion}`;
    return {
      ...base,
      status: 'warn',
      detail,
      affected: drifted.map((p) => p.kind),
      remediation: {
        kind: 'manual',
        suggestion: `Re-run ${commands.join(' and ')} to refresh the plugin`,
        command: commands[0],
      },
    };
  },
};

export const pluginChecks: Check[] = [versionDrift];
