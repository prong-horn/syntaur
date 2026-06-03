import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileExists } from '../utils/fs.js';
import { isSyntaurDataInstalled } from '../utils/install.js';
import { initCommand } from './init.js';
import { setupAdapterCommand } from './setup-adapter.js';
import { installSkillsToDir } from '../utils/install-skills.js';
import { readConfig, updateIntegrationConfig } from '../utils/config.js';
import {
  getAgentTarget,
  agentTargetIds,
  isHermesHomeCustom,
  hermesSkillsDir,
} from '../targets/registry.js';
import type { AgentTarget } from '../targets/types.js';

const DEFAULT_SKILLS_SOURCE = 'prong-horn/syntaur';

export interface CrossAgentInstallOptions {
  /** Comma-separated Syntaur agent id(s) (e.g. `pi` or `pi,hermes`). */
  target?: string;
  /** Alias/passthrough for `--target`; merged with it. */
  agent?: string;
  dryRun?: boolean;
  force?: boolean;
}

function parseTargetIds(options: CrossAgentInstallOptions): string[] {
  const raw = [options.target, options.agent].filter(Boolean).join(',');
  const ids = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return [...new Set(ids)];
}

function isNpxAvailable(): boolean {
  try {
    const r = spawnSync('npx', ['--version'], { stdio: 'ignore' });
    return !r.error && r.status === 0;
  } catch {
    return false;
  }
}

interface AssignmentContext {
  projectSlug?: string;
  assignmentSlug?: string;
}

async function readAssignmentContext(): Promise<AssignmentContext | null> {
  const p = resolve(process.cwd(), '.syntaur', 'context.json');
  if (!(await fileExists(p))) return null;
  try {
    return JSON.parse(await readFile(p, 'utf-8')) as AssignmentContext;
  } catch {
    return null;
  }
}

/**
 * Install Syntaur into one or more non-CC/Codex agents. Gated behind
 * `--target`/`--agent` so the default `syntaur setup` flow is never touched.
 *
 * Tier 1: `npx skills add prong-horn/syntaur --agent <skills.sh ids>` (with an
 * offline copy fallback). Tier 2: render the protocol-instruction files for
 * each selected agent that has an adapter, when an assignment context is
 * present. `--dry-run` prints every intended action and writes nothing.
 */
export async function crossAgentInstallCommand(
  options: CrossAgentInstallOptions,
): Promise<void> {
  const ids = parseTargetIds(options);
  if (ids.length === 0) {
    throw new Error('No agents specified. Use --target <id> or --agent <id>.');
  }

  const targets: AgentTarget[] = [];
  for (const id of ids) {
    const t = getAgentTarget(id);
    if (!t) {
      throw new Error(
        `Unknown agent "${id}". Known agents: ${agentTargetIds().join(', ')}`,
      );
    }
    // Claude Code / Codex install via their dedicated full-plugin path, not the
    // cross-agent skills.sh/offline flow — keep that boundary intact.
    if (t.nativePlugin) {
      throw new Error(
        `"${id}" installs as a native Syntaur plugin, not via cross-agent install. ` +
          `Use \`syntaur setup --${t.nativePlugin}\` (or \`syntaur ${t.nativePlugin === 'claude' ? 'install-plugin' : 'install-codex-plugin'}\`).`,
      );
    }
    targets.push(t);
  }

  const dryRun = Boolean(options.dryRun);
  const force = Boolean(options.force);
  // Phase 1 installs to each agent's global skills dir only; project scope is
  // deferred (see plan), so records are always 'global'.
  const scope = 'global' as const;
  const prefix = dryRun ? '[dry-run] ' : '';

  if (!dryRun && !(await isSyntaurDataInstalled())) {
    await initCommand({});
  }

  // --- Tier 1: skills via `npx skills add` (with offline fallback) ---
  const skillsShIds = targets.map((t) => t.skillsShAgentId ?? t.id);
  const argv = ['skills', 'add', DEFAULT_SKILLS_SOURCE, '--agent', ...skillsShIds];
  console.log(`${prefix}Tier 1 (skills): npx ${argv.join(' ')}`);

  let tier1Done = false;
  if (!dryRun) {
    if (isNpxAvailable()) {
      const r = spawnSync('npx', argv, { stdio: 'inherit' });
      tier1Done = !r.error && r.status === 0;
      if (!tier1Done) {
        console.log('`npx skills add` failed; falling back to offline copy.');
      }
    } else {
      console.log('npx not available; using offline skill copy.');
    }
  }

  // --- Offline fallback + Hermes $HERMES_HOME reconciliation ---
  for (const t of targets) {
    // Hermes resolves its dir fresh from $HERMES_HOME at call time — the
    // descriptor's frozen `skillsDir.global` can be stale if the env was set
    // after module load.
    const globalDir = t.id === 'hermes' ? hermesSkillsDir() : t.skillsDir?.global;
    if (!globalDir) continue;

    const offlineNeeded = !tier1Done; // also true under dry-run (tier1Done stays false)
    // skills.sh always installs hermes-agent to ~/.hermes/skills, ignoring
    // $HERMES_HOME — so a custom $HERMES_HOME must be covered explicitly even
    // when the npx install succeeded.
    const hermesCustom = t.id === 'hermes' && isHermesHomeCustom();
    if (!offlineNeeded && !hermesCustom) continue;

    if (dryRun) {
      const label = hermesCustom
        ? 'offline copy (always — custom $HERMES_HOME)'
        : 'offline copy (fallback if npx unavailable)';
      console.log(`${prefix}${label} -> ${globalDir}`);
      continue;
    }
    const reason = hermesCustom && tier1Done ? ' ($HERMES_HOME reconcile)' : '';
    await installSkillsToDir({ targetDir: globalDir, force });
    console.log(`Copied skills -> ${globalDir}${reason}`);
  }

  // --- Tier 2: protocol-instruction files (needs an assignment context) ---
  const adapterTargets = targets.filter((t) => t.instructions);
  if (adapterTargets.length > 0) {
    const ctx = await readAssignmentContext();
    const haveCtx = Boolean(ctx?.projectSlug && ctx?.assignmentSlug);

    for (const t of adapterTargets) {
      if (dryRun) {
        for (const f of t.instructions!.files) {
          console.log(
            `${prefix}Tier 2 (${t.id}): ${resolve(process.cwd(), f.path)}`,
          );
        }
        continue;
      }
      if (!haveCtx) {
        console.log(
          `No project-nested assignment context in cwd; skipping Tier-2 files for ${t.id}.`,
        );
        continue;
      }
      try {
        await setupAdapterCommand(t.id, {
          project: ctx!.projectSlug!,
          assignment: ctx!.assignmentSlug!,
          force,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.log(`Tier 2 for ${t.id} skipped: ${msg}`);
      }
    }
  }

  // --- Record install records ---
  if (!dryRun) {
    const current = (await readConfig()).integrations.installedAgents ?? {};
    const next = { ...current };
    for (const t of targets) {
      next[t.id] = { scope };
    }
    await updateIntegrationConfig({ installedAgents: next });
  }

  console.log(
    `${prefix}Done. Agents: ${targets.map((t) => t.displayName).join(', ')}.`,
  );
}
