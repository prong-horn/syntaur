import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { realpathSync, readFileSync, mkdirSync } from 'node:fs';
import { syntaurRoot } from '../utils/paths.js';
import { fileExists, writeFileForce } from '../utils/fs.js';

export type InstallKind = 'npx' | 'global' | 'local' | 'unknown';

interface DetectOptions {
  realpath?: (p: string) => string;
  readFile?: (p: string) => string;
  envUserAgent?: string;
}

/**
 * Anchored cache-layout regexes. All require a `/node_modules/` suffix after
 * the cache hash segment to avoid false positives on user dirs that happen
 * to contain `_npx` / `dlx` / `bunx-` literals. Order matches the legacy
 * `isRunningViaNpx` in `src/utils/npx-prompt.ts` so behavior is consistent.
 */
const NPX_PATTERNS: { kind: 'npm' | 'pnpm' | 'bun'; re: RegExp }[] = [
  { kind: 'npm', re: /\/_npx\/([^/]+)\/node_modules(?:\/|$)/ },
  { kind: 'pnpm', re: /\/pnpm\/dlx\/([^/]+)\/node_modules(?:\/|$)/ },
  { kind: 'bun', re: /\/bunx-([^/]+)\/node_modules(?:\/|$)/ },
];

/**
 * Canonical npm global layout: `<prefix>/lib/node_modules/syntaur/...`
 * Matches /usr/local, nvm's `<v>/lib/node_modules/syntaur/`, Homebrew, etc.
 */
const GLOBAL_PATTERN = /\/lib\/node_modules\/syntaur(?:\/|$)/;

/**
 * Resolve a file:// URL to an absolute filesystem path, applying realpath
 * so symlinks (e.g. an npm `bin/` symlink pointing into a cached node_modules)
 * resolve to the actual install location. Returns null on parse errors.
 */
function resolveScriptPath(
  scriptUrl: string,
  realpath: (p: string) => string,
): string | null {
  let p: string;
  try {
    p = fileURLToPath(scriptUrl);
  } catch {
    return null;
  }
  try {
    return realpath(p);
  } catch {
    // Path doesn't exist (test fixtures, deleted file). Fall back to the
    // unresolved path so classifier can still match by pattern.
    return p;
  }
}

function normalizeSlashes(p: string): string {
  return p.replace(/\\/g, '/');
}

/**
 * Classify the install origin of the running CLI.
 *
 * Decision order:
 *   1. npx-style cache patterns (anchored to `/node_modules/` suffix).
 *   2. `npm_config_user_agent` containing `npx/` (some pnpm-shim invocations
 *      don't put dlx in the path).
 *   3. Canonical npm global layout `/lib/node_modules/syntaur/`.
 *   4. Local checkout (walks up to find a `package.json` named `syntaur`
 *      whose dir is not under any `node_modules/`).
 *   5. `unknown` — the subcommand refuses these alongside `npx` to avoid
 *      registering a bundle path that may not survive.
 */
export function detectInstallKind(
  scriptUrl: string,
  opts: DetectOptions = {},
): InstallKind {
  const realpath = opts.realpath ?? realpathSync.native;
  const readFile = opts.readFile ?? ((p) => readFileSync(p, 'utf-8'));
  const ua =
    opts.envUserAgent !== undefined
      ? opts.envUserAgent
      : (process.env.npm_config_user_agent ?? '');

  const resolved = resolveScriptPath(scriptUrl, realpath);
  if (resolved === null) {
    return 'unknown';
  }
  const norm = normalizeSlashes(resolved);

  for (const pat of NPX_PATTERNS) {
    if (pat.re.test(norm)) return 'npx';
  }
  if (ua.includes('npx/')) {
    return 'npx';
  }

  if (GLOBAL_PATTERN.test(norm)) {
    return 'global';
  }

  // Walk up looking for a syntaur package.json that is NOT inside a
  // node_modules/ — that pattern indicates a local source checkout.
  let dir = dirname(resolved);
  for (let depth = 0; depth < 8; depth++) {
    const pkgJsonPath = join(dir, 'package.json');
    let raw: string;
    try {
      raw = readFile(pkgJsonPath);
    } catch {
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
      continue;
    }
    try {
      const pkg = JSON.parse(raw) as { name?: unknown };
      if (
        typeof pkg.name === 'string' &&
        pkg.name === 'syntaur' &&
        !normalizeSlashes(dir).includes('/node_modules/')
      ) {
        return 'local';
      }
    } catch {
      // Malformed package.json on the way up — ignore and keep walking.
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return 'unknown';
}

/**
 * Extract the cache-hash segment from an npx-style script URL.
 * Returns null for global/local/unknown installs.
 */
export function extractNpxHash(
  scriptUrl: string,
  opts: DetectOptions = {},
): string | null {
  const realpath = opts.realpath ?? realpathSync.native;
  const resolved = resolveScriptPath(scriptUrl, realpath);
  if (resolved === null) return null;
  const norm = normalizeSlashes(resolved);
  for (const pat of NPX_PATTERNS) {
    const m = norm.match(pat.re);
    if (m) return m[1] ?? null;
  }
  return null;
}

export function nudgeStampDir(): string {
  return resolve(syntaurRoot(), 'npx-handler-nudge');
}

/**
 * Sanitize the hash to a safe filename: anything outside [A-Za-z0-9_-] is
 * replaced with `_`. The npx-cache regex captures already exclude `/`, but
 * this is defense-in-depth against future upstream cache layouts.
 */
function sanitizeHash(hash: string): string {
  return hash.replace(/[^A-Za-z0-9_-]/g, '_') || '_';
}

export function nudgeStampPath(hash: string): string {
  return join(nudgeStampDir(), sanitizeHash(hash));
}

export async function hasNudgedHash(hash: string): Promise<boolean> {
  return fileExists(nudgeStampPath(hash));
}

export async function recordNudge(hash: string): Promise<void> {
  try {
    mkdirSync(nudgeStampDir(), { recursive: true });
  } catch {
    // Best-effort; if mkdir fails (e.g. a regular file at the path), the
    // writeFileForce below will surface its own error which we also swallow.
  }
  try {
    await writeFileForce(nudgeStampPath(hash), '');
  } catch {
    // Best-effort. Worst case the nudge fires again on next invocation,
    // which is annoying but not destructive.
  }
}

/**
 * Truthiness rules for `SYNTAUR_SKIP_HANDLER_NUDGE`:
 *   - `'1'`, `'true'`, `'yes'` (case-insensitive, trimmed) → disabled
 *   - empty, unset, `'0'`, `'false'`, whitespace → enabled
 *
 * Deliberately narrow so users who set the var to `'0'` to mean "off the
 * skip" don't accidentally disable the nudge.
 */
export function isHandlerNudgeDisabled(): boolean {
  const raw = process.env.SYNTAUR_SKIP_HANDLER_NUDGE;
  if (raw === undefined) return false;
  const trimmed = raw.trim();
  return /^(1|true|yes)$/i.test(trimmed);
}

export function nudgeMessage(): string {
  return 'syntaur: running from npx — the syntaur:// deep-link handler is not registered. Install durably with `npm i -g syntaur` to enable "Open in agent" buttons.';
}

export async function shouldNudgeForNpx(hash: string | null): Promise<boolean> {
  if (isHandlerNudgeDisabled()) return false;
  if (hash === null) return false;
  if (await hasNudgedHash(hash)) return false;
  return true;
}

/**
 * Args that short-circuit the nudge: when the user invoked `--help` or
 * `--version`, they're not running the CLI for real, so don't bother them
 * with the install-durably banner. Mirrors `META_ARGS` in
 * `src/utils/npx-prompt.ts`.
 */
const META_ARGS = new Set(['-h', '--help', '-V', '--version', 'help']);

/**
 * Pre-Commander startup hook. Mirrors `maybePromptInstall` from
 * `src/utils/npx-prompt.ts` in shape so `src/index.ts` can call them
 * back-to-back.
 */
export async function maybeNudgeForNpxInstall(scriptUrl: string): Promise<void> {
  if (detectInstallKind(scriptUrl) !== 'npx') return;
  const args = process.argv.slice(2);
  if (args.some((a) => META_ARGS.has(a))) return;
  const hash = extractNpxHash(scriptUrl);
  if (!(await shouldNudgeForNpx(hash))) return;
  // hash is non-null here — shouldNudgeForNpx returned false for null above.
  console.error(nudgeMessage());
  if (hash !== null) {
    await recordNudge(hash);
  }
}
