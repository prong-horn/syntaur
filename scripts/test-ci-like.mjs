#!/usr/bin/env node
/**
 * CI-like test runner: minimal PATH (node toolchain + jq), empty HOME, no SYNTAUR_HOME.
 *
 * Required on the stripped PATH (via /usr/bin, /bin, /usr/sbin, /sbin): git, sh, bash,
 * perl, ps, pgrep. Allowlisted tools resolved from the caller PATH and symlinked into
 * the temp bin dir: jq (mandatory — hook tests invoke it by name).
 */

import { execSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, symlinkSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = join(fileURLToPath(new URL('..', import.meta.url)));
const SYSTEM_PATH = ['/usr/bin', '/bin', '/usr/sbin', '/sbin'];
const TOOL_ALLOWLIST = ['jq'];

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

/**
 * @param {{ lookupPath?: string }} [options]
 * @returns {{ env: Record<string, string | undefined>; binDir: string; homeDir: string; jqPath: string }}
 */
export function buildCiLikeEnv(options = {}) {
  const lookupPath = options.lookupPath ?? process.env.PATH ?? '';
  const jqPath = resolveOnPath('jq', lookupPath);
  if (!jqPath) {
    throw new Error(
      'jq is required for hook tests — install with: brew install jq  OR  apt-get install -y jq',
    );
  }

  const binDir = mkdtempSync(join(tmpdir(), 'syntaur-ci-like-bin-'));
  const homeDir = mkdtempSync(join(tmpdir(), 'syntaur-ci-like-home-'));
  mkdirSync(homeDir, { recursive: true });

  const nodeDir = dirname(process.execPath);
  symlinkSync(process.execPath, join(binDir, 'node'));
  for (const name of ['npm', 'npx']) {
    const src = join(nodeDir, name);
    if (existsSync(src)) symlinkSync(src, join(binDir, name));
  }
  for (const tool of TOOL_ALLOWLIST) {
    const resolved = tool === 'jq' ? jqPath : resolveOnPath(tool, lookupPath);
    if (!resolved) continue;
    symlinkSync(resolved, join(binDir, tool));
  }

  const path = [binDir, ...SYSTEM_PATH].join(':');
  const env = { ...process.env, PATH: path, HOME: homeDir };
  delete env.SYNTAUR_HOME;
  return { env, binDir, homeDir, jqPath };
}

function run() {
  const scripts = process.argv.slice(2);
  const toRun = scripts.length > 0 ? scripts : ['test'];
  const cleanup = [];
  try {
    const built = buildCiLikeEnv();
    cleanup.push(built.binDir, built.homeDir);

    const dist = join(REPO_ROOT, 'dist/index.js');
    if (!existsSync(dist)) {
      console.error('dist/index.js missing — run npm run build first');
      process.exit(1);
    }

    for (const script of toRun) {
      const result = spawnSync('npm', ['run', script], {
        cwd: REPO_ROOT,
        env: built.env,
        stdio: 'inherit',
      });
      if (result.status !== 0) process.exit(result.status ?? 1);
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(2);
  } finally {
    for (const dir of cleanup) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }
  }
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) run();
