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
  async run(): Promise<CheckResult[]> {
    const cliVersion = await readCliVersion();
    // One result PER kind so each carries its OWN remediation command — an
    // aggregated single result could only surface one command and would leave
    // the other plugin stale when both drift.
    return Promise.all(
      PLUGIN_KINDS.map(async (kind): Promise<CheckResult> => {
        const base = { id: this.id, category: this.category, title: this.title, affected: [kind] as string[], autoFixable: false };
        const label = getPluginDisplayName(kind);

        const installed = await readManagedInstallVersion(kind);
        if (installed === null) {
          return { ...base, status: 'skipped', detail: `no managed ${label} install` };
        }
        if (!cliVersion) {
          return { ...base, status: 'skipped', detail: 'could not read the running CLI version' };
        }
        if (installed === cliVersion) {
          return { ...base, status: 'pass', detail: `${label} ${installed} matches CLI` };
        }
        const command = `${getPluginInstallCommand(kind)} --force`;
        return {
          ...base,
          status: 'warn',
          detail: `installed ${label} v${installed} differs from CLI v${cliVersion}`,
          remediation: {
            kind: 'manual',
            suggestion: `Re-run \`${command}\` to refresh the ${label}`,
            command,
          },
        };
      }),
    );
  },
};

export const pluginChecks: Check[] = [versionDrift];
