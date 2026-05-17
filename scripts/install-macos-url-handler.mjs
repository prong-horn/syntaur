#!/usr/bin/env node
/**
 * Register `syntaur://` as a URL scheme handler on macOS.
 *
 * Postinstall hook. Builds an AppleScript applet (`.app` bundle) that
 * LaunchServices routes incoming `syntaur://...` URLs to via the standard
 * `on open location` Apple Event handler, then runs `lsregister -f` to
 * register it.
 *
 * Why an AppleScript applet, not a bare Bash executable: macOS URL scheme
 * handlers receive URLs as `kAEGetURL` Apple Events, not as `argv[1]`. A plain
 * Bash exec inside an `.app` bundle never sees the URL — `$1` is empty. The
 * AppleScript runtime is the simplest way to handle the Apple Event without
 * shipping a compiled Swift/ObjC helper; `osacompile` produces a real `.app`
 * with the right entry point.
 *
 * The AppleScript handler shells out to the installed `syntaur` CLI using the
 * absolute path to `node` (= `process.execPath` at install time) and the
 * absolute path to the CLI entry (`bin/syntaur.js`), so LaunchServices's
 * stripped PATH doesn't matter.
 *
 * All failures are caught and logged as warnings. The script always exits 0 so
 * `npm install` never fails because of URL-scheme registration.
 *
 * No-op on non-darwin platforms.
 */

import { existsSync, mkdirSync, rmSync, writeFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const BUNDLE_ID = 'app.syntaur.url-handler';
const BUNDLE_NAME = 'Syntaur URL Handler';
const URL_SCHEME = 'syntaur';
const LSREGISTER = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';
const OSACOMPILE = '/usr/bin/osacompile';

function main() {
  if (process.platform !== 'darwin') {
    return; // Linux/Windows handler is deferred to a future task.
  }

  try {
    const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    const cliBin = realpathSync(resolve(pkgRoot, 'bin/syntaur.js'));
    const nodeBin = process.execPath;
    const bundleParent = join(
      homedir(),
      'Library',
      'Application Support',
      'Syntaur',
    );
    const bundlePath = join(bundleParent, 'syntaur-url.app');

    mkdirSync(bundleParent, { recursive: true });

    // Overwrite the bundle in place for idempotency. osacompile -o overwrites
    // an existing target only if we remove it first.
    if (existsSync(bundlePath)) {
      rmSync(bundlePath, { recursive: true, force: true });
    }

    // 1. Write the AppleScript source to a temp file.
    const scriptPath = join(
      tmpdir(),
      `syntaur-url-handler-${process.pid}.applescript`,
    );
    writeFileSync(scriptPath, renderAppleScript({ nodeBin, cliBin }), 'utf-8');

    // 2. Compile it into an .app bundle. osacompile produces a real macOS app
    //    with the AppleScript runtime as its main executable — that runtime
    //    knows how to dispatch the kAEGetURL Apple Event to our handler.
    const compile = spawnSync(
      OSACOMPILE,
      ['-o', bundlePath, scriptPath],
      { stdio: 'pipe', encoding: 'utf-8' },
    );
    if (compile.status !== 0) {
      throw new Error(
        `osacompile exited with code ${compile.status}: ${compile.stderr || compile.stdout}`,
      );
    }

    // 3. Patch the Info.plist that osacompile generated to add the URL scheme
    //    declaration, the bundle id, and a name. osacompile's default plist
    //    has no CFBundleURLTypes — without these LaunchServices won't route
    //    syntaur:// URLs to the bundle.
    const infoPlistPath = join(bundlePath, 'Contents', 'Info.plist');
    if (!existsSync(infoPlistPath)) {
      throw new Error(`osacompile did not produce ${infoPlistPath}`);
    }

    // Use PlistBuddy to surgically add/replace the keys we care about. Each
    // step tries Add first (for missing keys) and falls back to Set (for keys
    // osacompile already wrote). The :CFBundleURLTypes array we always Add
    // fresh because osacompile never writes one.
    runPlistBuddy(infoPlistPath, [
      [`Add :CFBundleIdentifier string ${BUNDLE_ID}`, `Set :CFBundleIdentifier ${BUNDLE_ID}`],
      [`Add :CFBundleName string ${BUNDLE_NAME}`, `Set :CFBundleName ${BUNDLE_NAME}`],
      ['Add :LSUIElement bool true', 'Set :LSUIElement true'],
      ['Delete :CFBundleURLTypes', null],
      ['Add :CFBundleURLTypes array', null],
      ['Add :CFBundleURLTypes:0 dict', null],
      ['Add :CFBundleURLTypes:0:CFBundleURLName string Syntaur', null],
      ['Add :CFBundleURLTypes:0:CFBundleURLSchemes array', null],
      [`Add :CFBundleURLTypes:0:CFBundleURLSchemes:0 string ${URL_SCHEME}`, null],
    ]);

    // 4. Register with LaunchServices so the OS routes syntaur:// URLs here.
    const ls = spawnSync(LSREGISTER, ['-f', bundlePath], { stdio: 'ignore' });
    if (ls.status !== 0) {
      console.warn(
        `syntaur: lsregister returned ${ls.status} while registering ${bundlePath} — \`open syntaur://...\` may not route through the CLI handler until you run \`${LSREGISTER} -f ${bundlePath}\` manually.`,
      );
    }

    // 5. Clean up the temp source file.
    try { rmSync(scriptPath); } catch { /* not fatal */ }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`syntaur: skipping macOS URL-handler registration (${msg})`);
  }
}

/**
 * Render the AppleScript source for the URL handler applet.
 *
 * The `on open location` handler is the documented entry point for URL scheme
 * apps. It fires for each `kAEGetURL` Apple Event — i.e. each time the OS or
 * another app calls `open syntaur://...`.
 *
 * The handler shells out to the installed `syntaur url <url>` CLI via the
 * baked-in absolute paths to `node` and the CLI entry point. CLI stdout +
 * stderr are appended to `~/Library/Logs/Syntaur/url-handler.log` (created on
 * first run) so deep-link failures are diagnosable. AppleScript-level errors
 * (e.g. CLI exited non-zero) fall through to a second `printf` that appends a
 * summary line to the same log.
 */
function renderAppleScript({ nodeBin, cliBin }) {
  // Build paths into AppleScript variables so the shell command can wrap each
  // one with `quoted form of`. Embedding paths directly as AppleScript string
  // literals would defeat shell quoting — any path with a space or shell
  // metacharacter would break the command (or worse, run an unintended one).
  // Every interpolated value into the shell line goes through `quoted form of`
  // exactly once.
  const node = appleScriptString(nodeBin);
  const cli = appleScriptString(cliBin);

  return [
    'on open location theURL',
    `\tset nodeBin to ${node}`,
    `\tset cliBin to ${cli}`,
    '\tset libPath to POSIX path of (path to library folder from user domain)',
    '\tset logDir to libPath & "Logs/Syntaur"',
    '\tset logFile to logDir & "/url-handler.log"',
    '\ttry',
    // Ensure the log dir exists. Use absolute paths so LaunchServices'
    // stripped PATH does not matter.
    '\t\tdo shell script "/bin/mkdir -p " & quoted form of logDir',
    // Append stdout+stderr from `syntaur url <url>` to the log file. Without
    // this, errors from the CLI (terminal not installed, assignment not
    // found, etc.) would be silently discarded — `do shell script` redirects
    // to /dev/null by default, and the Apple Event has no terminal.
    `\t\tdo shell script quoted form of nodeBin & " " & quoted form of cliBin & " url " & quoted form of theURL & " >> " & quoted form of logFile & " 2>&1"`,
    '\ton error errMsg number errNum',
    // do-shell-script errors fire on non-zero CLI exit. Append the failure to
    // the same log so the user can find it. Wrapped in its own try because
    // this fallback should never crash the handler.
    '\t\ttry',
    `\t\t\tdo shell script "/usr/bin/printf '%s\\\\n' " & quoted form of ("syntaur:// handler failed for " & theURL & ": " & errMsg & " (" & errNum & ")") & " >> " & quoted form of logFile`,
    '\t\tend try',
    '\tend try',
    'end open location',
    '',
    'on run',
    '\t-- No-op when the app is double-clicked without a URL. Users should',
    '\t-- not launch this app directly; it exists only as a URL-scheme target.',
    'end run',
    '',
  ].join('\n');
}

/**
 * Quote a string for embedding inside an AppleScript double-quoted literal.
 * AppleScript interprets backslash and double-quote inside "..." strings;
 * everything else passes through.
 */
function appleScriptString(value) {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Run a sequence of PlistBuddy commands against the given plist. Each step is
 * either a single command string (run as-is, error fatal) or a
 * `[primary, fallback]` pair (run primary; if it fails, try fallback; only
 * fatal if both fail). PlistBuddy uses different commands for Add vs Set
 * depending on whether the key already exists.
 */
function runPlistBuddy(plistPath, steps) {
  for (const step of steps) {
    if (Array.isArray(step)) {
      const [primary, fallback] = step;
      const a = spawnSync('/usr/libexec/PlistBuddy', ['-c', primary, plistPath], {
        stdio: 'pipe',
        encoding: 'utf-8',
      });
      if (a.status === 0) continue;
      if (fallback === null) continue; // Add-only commands are allowed to fail silently.
      const b = spawnSync('/usr/libexec/PlistBuddy', ['-c', fallback, plistPath], {
        stdio: 'pipe',
        encoding: 'utf-8',
      });
      if (b.status !== 0) {
        throw new Error(
          `PlistBuddy failed: ${primary} OR ${fallback}: ${b.stderr || b.stdout}`,
        );
      }
    } else {
      const r = spawnSync('/usr/libexec/PlistBuddy', ['-c', step, plistPath], {
        stdio: 'pipe',
        encoding: 'utf-8',
      });
      if (r.status !== 0) {
        throw new Error(
          `PlistBuddy failed: ${step}: ${r.stderr || r.stdout}`,
        );
      }
    }
  }
}

main();
