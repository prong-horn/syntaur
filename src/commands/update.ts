import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import { detectInstallKind, type InstallKind } from '../launch/index.js';
import { compareSemver } from '../utils/npx-prompt.js';
import { readPackageVersion } from '../utils/version.js';
import { getConfiguredOrLegacyManagedPluginDir } from '../utils/install.js';

export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun';
const PACKAGE_MANAGERS: readonly PackageManager[] = ['npm', 'pnpm', 'yarn', 'bun'];

export interface UpdateRunResult {
  code: number;
  stderr: string;
  error?: Error;
}

// Single runner for BOTH the package-manager update spawn and the fresh
// `install-plugin` refresh spawn. Injectable so tests never spawn.
export type UpdateRunner = (
  cmd: string,
  args: string[],
  opts?: { env?: NodeJS.ProcessEnv },
) => Promise<UpdateRunResult>;

export interface UpdateOptions {
  scriptUrl: string;
  version?: string;
  check?: boolean;
  dryRun?: boolean;
  skipRefresh?: boolean;
  forceSkills?: boolean;
  enable?: boolean;
  pm?: string;
  yes?: boolean;
}

export interface UpdateDeps {
  runner?: UpdateRunner;
  detectKind?: (scriptUrl: string) => InstallKind;
  detectKindDeps?: { realpath?: (p: string) => string; readFile?: (p: string) => string; envUserAgent?: string };
  fetchLatest?: (pkg: string, timeoutMs: number) => Promise<string | null>;
  getManagedDir?: (kind: 'claude' | 'codex') => Promise<string | null>;
  readOldVersion?: (scriptUrl: string) => Promise<string | null>;
  env?: NodeJS.ProcessEnv;
  log?: (msg: string) => void;
}

const LOCAL_MSG =
  "Running from a dev/linked checkout — `syntaur update` won't touch a linked install. " +
  'Pull + rebuild in your repo, then `syntaur install-plugin --force` to refresh skills.';
const NPX_MSG =
  "Running via npx — there's no durable global install to update. Install durably first: `npm i -g syntaur`.";

// Duplicated from src/utils/doctor/checks/env.ts (module-private there) to avoid
// reaching into the doctor module.
async function fetchLatestNpmVersion(pkg: string, timeoutMs: number): Promise<string | null> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`https://registry.npmjs.org/${pkg}/latest`, { signal: controller.signal });
    if (!res.ok) return null;
    const body = (await res.json()) as { version?: unknown };
    return typeof body.version === 'string' ? body.version : null;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

// Default runner: stdout inherited; stderr captured AND teed to process.stderr so
// the user sees progress while we can still classify failures (yarn-berry/EACCES).
const defaultRunner: UpdateRunner = (cmd, args, opts) =>
  new Promise((resolvePromise) => {
    const child = spawn(cmd, args, {
      env: opts?.env ?? process.env,
      stdio: ['inherit', 'inherit', 'pipe'],
      shell: process.platform === 'win32',
    });
    let stderr = '';
    child.stderr?.on('data', (d) => {
      const s = d.toString();
      stderr += s;
      process.stderr.write(s);
    });
    child.on('error', (error) => resolvePromise({ code: -1, stderr, error }));
    child.on('close', (code) => resolvePromise({ code: code ?? -1, stderr }));
  });

function resolveScriptPath(scriptUrl: string, realpath: (p: string) => string): string | null {
  try {
    const p = scriptUrl.startsWith('file:') ? fileURLToPath(scriptUrl) : scriptUrl;
    try {
      return realpath(p);
    } catch {
      return p;
    }
  } catch {
    return null;
  }
}

export function detectPackageManager(resolvedPath: string | null, env: NodeJS.ProcessEnv): PackageManager | null {
  const ua = env.npm_config_user_agent ?? '';
  if (ua.startsWith('pnpm/')) return 'pnpm';
  if (ua.startsWith('yarn/')) return 'yarn';
  if (ua.startsWith('bun')) return 'bun';
  if (ua.startsWith('npm/')) return 'npm';

  const p = (resolvedPath ?? '').replace(/\\/g, '/');
  const norm = (v: string | undefined) => (v ? v.replace(/\\/g, '/') : '');
  if (p.includes('/pnpm/') || p.includes('pnpm-global')) return 'pnpm';
  if (p.includes('/.bun/') || (env.BUN_INSTALL && p.startsWith(norm(env.BUN_INSTALL)))) return 'bun';
  if (p.includes('/.config/yarn/global') || p.includes('/yarn/global')) return 'yarn';
  if (env.PNPM_HOME && p.startsWith(norm(env.PNPM_HOME))) return 'pnpm';
  if (p.includes('/lib/node_modules/')) return 'npm';
  return null;
}

export function pmUpdateCommand(pm: PackageManager, spec: string): { cmd: string; args: string[] } {
  const pkg = `syntaur@${spec}`;
  switch (pm) {
    case 'npm':
      return { cmd: 'npm', args: ['install', '-g', pkg] };
    case 'pnpm':
      return { cmd: 'pnpm', args: ['add', '-g', pkg] };
    case 'yarn':
      return { cmd: 'yarn', args: ['global', 'add', pkg] };
    case 'bun':
      return { cmd: 'bun', args: ['add', '-g', pkg] };
  }
}

function classifyUpdateFailure(pm: PackageManager, cmd: string, args: string[], res: UpdateRunResult): Error {
  if (res.error && (res.error as NodeJS.ErrnoException).code === 'ENOENT') {
    return new Error(`\`${pm}\` not found on PATH — install it or pass \`--pm <other>\`.`);
  }
  if (pm === 'yarn' && /\bglobal\b|unknown command/i.test(res.stderr)) {
    return new Error(
      "`yarn global` isn't available (Yarn 2+ removed it). Re-run with `--pm npm` (or pnpm/bun), or install syntaur globally with your preferred manager.",
    );
  }
  if (/EACCES|permission denied/i.test(res.stderr)) {
    return new Error(
      'Global install failed (permissions?). Try a Node version manager, or re-run with appropriate privileges.',
    );
  }
  return new Error(`${pm} update failed (exit ${res.code}): ${cmd} ${args.join(' ')}`);
}

export async function updateCommand(options: UpdateOptions, deps: UpdateDeps = {}): Promise<void> {
  const log = deps.log ?? ((m: string) => console.log(m));
  const env = deps.env ?? process.env;
  const runner = deps.runner ?? defaultRunner;
  const realpath = deps.detectKindDeps?.realpath ?? realpathSync.native;
  const detectKind = deps.detectKind ?? ((u: string) => detectInstallKind(u, deps.detectKindDeps));
  const fetchLatest = deps.fetchLatest ?? fetchLatestNpmVersion;
  const getManagedDir = deps.getManagedDir ?? getConfiguredOrLegacyManagedPluginDir;
  const readOld = deps.readOldVersion ?? readPackageVersion;

  // --- 1. Resolve read-only facts ---
  const kind = detectKind(options.scriptUrl);
  const { pm, ambiguous: pmAmbiguous } = resolvePm(
    options.pm,
    resolveScriptPath(options.scriptUrl, realpath),
    env,
  );
  const old = (await readOld(options.scriptUrl)) ?? 'unknown';
  const target = options.version ?? (await fetchLatest('syntaur', 4000));

  // --- 2. --check (read-only; works from any install kind) ---
  if (options.check) {
    if (target === null) {
      log("Couldn't reach the npm registry to find the latest version. Retry, or pin one with `--version <v>`.");
      return;
    }
    if (options.version) {
      log(`Current ${old} → requested ${target} (pinned). Run \`syntaur update --version ${target}\` to apply.`);
    } else if (compareSemver(old, target) >= 0) {
      log(`syntaur is up to date (${old}).`);
    } else {
      log(`Update available: ${old} → ${target}. Run \`syntaur update\` to apply.`);
    }
    log(`(install kind: ${kind}, package manager: ${pm})`);
    if (kind === 'local' || kind === 'npx') {
      log(`Note: this is a ${kind} install — \`syntaur update\` can't self-update it here.`);
    }
    return;
  }

  // --- 3. Install-kind gate (mutating path): skip ONLY local/npx ---
  if (kind === 'local') {
    log(LOCAL_MSG);
    return;
  }
  if (kind === 'npx') {
    log(NPX_MSG);
    return;
  }

  // Past the gate: we're on the mutating path and will actually use the PM.
  if (pmAmbiguous) {
    log("Couldn't determine your package manager — assuming npm. Override with `--pm <npm|pnpm|yarn|bun>` if wrong.");
  }

  // Need a target to do anything beyond here.
  if (target === null) {
    throw new Error(
      "Couldn't reach the npm registry to find the latest version. Retry, or pin one with `--version <v>`.",
    );
  }

  // --- 4. No-op decision (before dry-run, so dry-run is truthful) ---
  const isNoop = options.version ? old === target : compareSemver(old, target) >= 0;

  // --- 5. --dry-run ---
  if (options.dryRun) {
    if (isNoop) {
      log(`Would make no changes — already up to date (${old}).`);
      return;
    }
    const { cmd, args } = pmUpdateCommand(pm, target);
    log(`Would run: ${cmd} ${args.join(' ')}`);
    if (!options.skipRefresh) {
      const dir = await getManagedDir('claude');
      log(`Would refresh via: syntaur install-plugin --force${dir ? ` (SYNTAUR_PLUGIN_TARGET=${dir})` : ''}`);
    }
    return;
  }

  // --- 6. No-op (real run) ---
  if (isNoop) {
    log(`Already up to date (${old}). No changes.`);
    return;
  }

  // --- 7. Run the package-manager update ---
  const { cmd, args } = pmUpdateCommand(pm, target);
  log(`Updating syntaur via ${pm}: ${cmd} ${args.join(' ')}`);
  const res = await runner(cmd, args);
  if (res.code !== 0 || res.error) {
    throw classifyUpdateFailure(pm, cmd, args, res);
  }

  // --- Refresh plugin/skills in a FRESH process (new package root) ---
  let refreshNote = '';
  if (options.skipRefresh) {
    refreshNote = 'Skipped plugin/skills refresh (--skip-refresh).';
  } else {
    refreshNote = await refreshPluginSkills(options, runner, getManagedDir, env, log);
  }

  // --- Report ---
  log(`Updated syntaur: ${old} → ${target}`);
  if (refreshNote) log(refreshNote);
  log('Restart your agent (Claude Code / Codex) to pick up new skills.');
}

function resolvePm(
  pmFlag: string | undefined,
  resolvedPath: string | null,
  env: NodeJS.ProcessEnv,
): { pm: PackageManager; ambiguous: boolean } {
  if (pmFlag) {
    if (!(PACKAGE_MANAGERS as readonly string[]).includes(pmFlag)) {
      throw new Error(`Invalid --pm "${pmFlag}". Valid: ${PACKAGE_MANAGERS.join(', ')}`);
    }
    return { pm: pmFlag as PackageManager, ambiguous: false };
  }
  const detected = detectPackageManager(resolvedPath, env);
  // Ambiguous → default npm, but let the caller decide whether to warn (only
  // worth warning on the mutating path, not for --check or a local/npx skip).
  return detected === null ? { pm: 'npm', ambiguous: true } : { pm: detected, ambiguous: false };
}

// Spawn the FRESHLY-installed `syntaur install-plugin` so it copies the NEW
// package root's skills (an in-process call would copy the old, still-loaded root).
// SYNTAUR_PLUGIN_TARGET pins the dir → disables the target prompt AND the
// migration confirm in install-plugin.
async function refreshPluginSkills(
  options: UpdateOptions,
  runner: UpdateRunner,
  getManagedDir: (kind: 'claude' | 'codex') => Promise<string | null>,
  env: NodeJS.ProcessEnv,
  log: (m: string) => void,
): Promise<string> {
  const managedDir = await getManagedDir('claude');
  const args = ['install-plugin', '--force'];
  if (options.forceSkills) args.push('--force-skills');
  if (options.enable) args.push('--enable');

  const childEnv: NodeJS.ProcessEnv = { ...env };
  if (managedDir) childEnv.SYNTAUR_PLUGIN_TARGET = managedDir;

  // After a successful global update, PATH `syntaur` resolves to the new version.
  log(`Refreshing plugin + skills: syntaur ${args.join(' ')}`);
  const res = await runner('syntaur', args, { env: childEnv });
  if (res.code !== 0 || res.error) {
    return 'Warning: skills refresh failed — run `syntaur install-plugin --force` manually.';
  }
  return 'Refreshed plugin + skills.';
}
