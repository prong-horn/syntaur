import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { cp, mkdir, readFile } from 'node:fs/promises';
import { fileExists } from '../utils/fs.js';
import { isSyntaurDataInstalled } from '../utils/install.js';
import { findPackageRoot } from '../utils/package-root.js';
import { initCommand } from './init.js';
import { setupAdapterCommand } from './setup-adapter.js';
import { installSkillsToDir } from '../utils/install-skills.js';
import { readConfig, updateIntegrationConfig } from '../utils/config.js';
import {
  resolveAgentTargets,
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

export type Tier3InstallResult = 'installed' | 'already-present' | 'dry-run' | 'failed' | 'none';

/**
 * Copy a target's Tier-3 enforcement plugin into the agent's plugin/extension dir.
 * Idempotent: skips when already installed unless `force`. Returns a status so the
 * caller can surface a copy FAILURE instead of silently reporting success.
 * Exported for tests.
 */
export async function installTier3Plugin(
  t: AgentTarget,
  opts: { dryRun?: boolean; force?: boolean; prefix?: string } = {},
): Promise<Tier3InstallResult> {
  if (!t.tier3) return 'none';
  const plugin = t.tier3;
  const installDir = plugin.installDir();
  const prefix = opts.prefix ?? '';
  if (opts.dryRun) {
    console.log(`${prefix}Tier 3 (${t.id}): ${plugin.source} -> ${installDir}`);
    return 'dry-run';
  }
  // "Already installed" means the ENTRY file is present — not merely the dir, which
  // a prior failed/partial copy could have left empty. An incomplete dir falls
  // through to a (self-healing) re-copy below.
  if ((await fileExists(join(installDir, plugin.entry))) && !opts.force) {
    console.log(
      `Tier 3 (${t.id}): already installed at ${installDir} (use --force to overwrite).`,
    );
    return 'already-present';
  }
  try {
    const sourceDir = resolve(await findPackageRoot(plugin.source), plugin.source);
    await mkdir(dirname(installDir), { recursive: true });
    await cp(sourceDir, installDir, { recursive: true, force: true });
    console.log(`Tier 3 (${t.id}): installed ${plugin.kind} -> ${installDir}`);
    return 'installed';
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`Tier 3 for ${t.id} FAILED: ${msg}`);
    return 'failed';
  }
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

  // Resolve built-ins + user descriptors once; surface any loader warnings so a
  // malformed `~/.syntaur/targets/*.json` is visible rather than silently ignored.
  const { targets: known, warnings } = await resolveAgentTargets();
  for (const w of warnings) console.log(`Warning (user target): ${w}`);
  const byId = new Map(known.map((t) => [t.id, t]));

  const targets: AgentTarget[] = [];
  for (const id of ids) {
    const t = byId.get(id);
    if (!t) {
      throw new Error(
        `Unknown agent "${id}". Known agents: ${known.map((k) => k.id).join(', ')}`,
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
    const offlineNeeded = !tier1Done; // also true under dry-run (tier1Done stays false)
    if (!globalDir) {
      // No offline fallback path for this agent. If Tier-1 actually failed (npx
      // unavailable/errored — not a dry-run), its skills did NOT install; surface
      // that rather than printing a misleading "Done". (A user descriptor may have
      // no skillsDir.global — see references/user-targets.md "Tier-1 reachability".)
      if (offlineNeeded && !dryRun) {
        console.log(
          `Warning: skills NOT installed for ${t.displayName} — Tier-1 (npx skills add) ` +
            `was unavailable/failed and the descriptor has no skillsDir.global for an offline copy.`,
        );
      }
      continue;
    }

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

  // --- Tier 3: deep-enforcement plugins (boundary hook + cleanup + commands) ---
  // Implied when an agent with a `tier3` descriptor is targeted — no extra flag.
  const tier3Failures: string[] = [];
  for (const t of targets.filter((x) => x.tier3)) {
    const result = await installTier3Plugin(t, { dryRun, force, prefix });
    if (result === 'failed') tier3Failures.push(t.displayName);
  }
  // A failed Tier-3 copy means the agent would run WITHOUT enforcement — fail loudly
  // rather than recording the agent installed and printing "Done".
  if (tier3Failures.length > 0) {
    throw new Error(
      `Tier-3 enforcement plugin failed to install for: ${tier3Failures.join(', ')}. ` +
        `Enforcement is NOT active for ${tier3Failures.length > 1 ? 'those agents' : 'that agent'} — ` +
        `check permissions and re-run \`syntaur setup --target <id> --force\`.`,
    );
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
