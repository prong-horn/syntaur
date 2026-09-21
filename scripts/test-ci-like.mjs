#!/usr/bin/env node
/**
 * CI-like test runner: minimal PATH (node toolchain + jq), empty HOME, no SYNTAUR_HOME.
 *
 * Required on the stripped PATH (via /usr/bin, /bin, /usr/sbin, /sbin): git, sh, bash,
 * perl, ps, pgrep. Allowlisted tools resolved from the caller PATH and symlinked into
 * the temp bin dir: jq, npm, npx (mandatory — hook tests and this script invoke them by name).
 */

import { execSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, symlinkSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = join(fileURLToPath(new URL('..', import.meta.url)));
const SYSTEM_PATH = ['/usr/bin', '/bin', '/usr/sbin', '/sbin'];

const TOOL_HINTS = {
  jq: 'jq is required for hook tests — install with: brew install jq  OR  apt-get install -y jq',
  npm: 'npm is required — install Node.js with npm (https://nodejs.org/)',
  npx: 'npx is required — install Node.js with npm (https://nodejs.org/)',
};

function resolveOnPath(tool, lookupPath) {
  try {
    return execSync(`command -v ${tool}`, {
      encoding: 'utf8',
      env: { ...process.env, PATH: lookupPath },
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return null;
  }
}

function resolveToolPath(tool, lookupPath) {
  let path = resolveOnPath(tool, lookupPath);
  if (!path && (tool === 'npm' || tool === 'npx')) {
    const sibling = join(dirname(process.execPath), tool);
    if (existsSync(sibling)) path = sibling;
  }
  if (!path) {
    throw new Error(TOOL_HINTS[tool] ?? `${tool} is required but was not found on PATH`);
  }
  return path;
}

/**
 * @param {{ lookupPath?: string }} [options]
 * @returns {{
 *   env: Record<string, string | undefined>;
 *   binDir: string;
 *   homeDir: string;
 *   jqPath: string;
 *   npmPath: string;
 *   npxPath: string;
 * }}
 */
export function buildCiLikeEnv(options = {}) {
  const lookupPath = options.lookupPath ?? process.env.PATH ?? '';
  const jqPath = resolveToolPath('jq', lookupPath);
  const npmPath = resolveToolPath('npm', lookupPath);
  const npxPath = resolveToolPath('npx', lookupPath);

  const binDir = mkdtempSync(join(tmpdir(), 'syntaur-ci-like-bin-'));
  const homeDir = mkdtempSync(join(tmpdir(), 'syntaur-ci-like-home-'));
  mkdirSync(homeDir, { recursive: true });

  symlinkSync(process.execPath, join(binDir, 'node'));
  symlinkSync(npmPath, join(binDir, 'npm'));
  symlinkSync(npxPath, join(binDir, 'npx'));
  symlinkSync(jqPath, join(binDir, 'jq'));

  const path = [binDir, ...SYSTEM_PATH].join(':');
  const env = { ...process.env, PATH: path, HOME: homeDir };
  delete env.SYNTAUR_HOME;
  return { env, binDir, homeDir, jqPath, npmPath, npxPath };
}

function removeTemps(dirs) {
  for (const dir of dirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
}

function run() {
  const scripts = process.argv.slice(2);
  const toRun = scripts.length > 0 ? scripts : ['test'];
  let exitCode = 0;
  const cleanup = [];

  const doCleanup = () => {
    removeTemps(cleanup);
    cleanup.length = 0;
  };

  process.once('SIGINT', () => {
    doCleanup();
    process.exit(130);
  });
  process.once('SIGTERM', () => {
    doCleanup();
    process.exit(143);
  });

  try {
    const built = buildCiLikeEnv();
    cleanup.push(built.binDir, built.homeDir);

    const dist = join(REPO_ROOT, 'dist/index.js');
    if (!existsSync(dist)) {
      console.error('dist/index.js missing — run npm run build first');
      exitCode = 1;
    } else {
      for (const script of toRun) {
        const result = spawnSync('npm', ['run', script], {
          cwd: REPO_ROOT,
          env: built.env,
          stdio: 'inherit',
        });
        if (result.status !== 0) {
          exitCode = result.status ?? 1;
          break;
        }
      }
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    exitCode = 2;
  } finally {
    doCleanup();
  }
  process.exit(exitCode);
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) run();
