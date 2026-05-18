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

    // Detect which AppleScript-driven terminals are installed. osacompile
    // resolves application terminology at compile time, so a `tell application
    // "Ghostty"` block would fail to compile if Ghostty isn't installed. We
    // only embed tell-blocks for apps we find on disk; unknown/missing
    // terminals fall back to a shell-out path which goes through the CLI's
    // executeLaunchPlan (and may need its own TCC grant on the parent shell
    // process).
    const installedTerminals = detectInstalledTerminals();

    // 1. Write the AppleScript source to a temp file.
    const scriptPath = join(
      tmpdir(),
      `syntaur-url-handler-${process.pid}.applescript`,
    );
    writeFileSync(
      scriptPath,
      renderAppleScript({ nodeBin, cliBin, installedTerminals }),
      'utf-8',
    );

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

    // 4. Re-sign the bundle ad-hoc. osacompile produces an ad-hoc signed
    //    bundle, but PlistBuddy edits invalidate that signature ("Info.plist
    //    not bound to signature"). Modern macOS refuses to prompt for
    //    Automation/TCC permissions on unsigned bundles and denies Apple
    //    events outright with error -1743 "Not authorized". Re-signing with
    //    `--force --deep --sign -` produces a fresh ad-hoc signature that
    //    includes the patched Info.plist, which is enough for TCC.
    const sign = spawnSync(
      '/usr/bin/codesign',
      ['--force', '--deep', '--sign', '-', bundlePath],
      { stdio: 'pipe', encoding: 'utf-8' },
    );
    if (sign.status !== 0) {
      console.warn(
        `syntaur: codesign returned ${sign.status} while re-signing ${bundlePath} — macOS may deny Automation permission. stderr: ${sign.stderr}`,
      );
    }

    // 5. Register with LaunchServices so the OS routes syntaur:// URLs here.
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
/**
 * Detect which AppleScript-driven terminals are installed on this Mac.
 * osacompile resolves application terminology at compile time, so we can
 * only emit `tell application "X"` blocks for apps that exist on disk.
 *
 * Returns a set of terminal ids that match the syntaur `TerminalChoice` enum.
 * Terminal.app is always assumed present (it ships with macOS).
 */
function detectInstalledTerminals() {
  const installed = new Set(['terminal-app']);
  const bundleIds = {
    iterm: 'com.googlecode.iterm2',
    ghostty: 'com.mitchellh.ghostty',
  };
  for (const [id, bundleId] of Object.entries(bundleIds)) {
    const r = spawnSync(
      'mdfind',
      [`kMDItemCFBundleIdentifier == '${bundleId}'`],
      { encoding: 'utf-8' },
    );
    if (r.status === 0 && r.stdout.trim().length > 0) {
      installed.add(id);
    }
  }
  return installed;
}

/**
 * Build the AppleScript `if/else if` chain that dispatches based on the
 * terminal id the CLI returned. We only emit `tell application "X"` blocks
 * for terminals confirmed installed (`installedTerminals`); everything else
 * falls through to a shell-out that re-invokes the CLI without --print-plan
 * so `executeLaunchPlan` does the spawn.
 *
 * Returns an array of AppleScript source lines (no trailing newline).
 */
function buildTerminalDispatch(installedTerminals) {
  const branches = [];
  if (installedTerminals.has('terminal-app')) {
    branches.push({
      id: 'terminal-app',
      block: [
        '\t\t\ttell application "Terminal"',
        '\t\t\t\tactivate',
        '\t\t\t\tdo script shellCmd',
        '\t\t\tend tell',
      ],
    });
  }
  if (installedTerminals.has('iterm')) {
    branches.push({
      id: 'iterm',
      block: [
        '\t\t\ttell application "iTerm"',
        '\t\t\t\tactivate',
        '\t\t\t\tset newWindow to (create window with default profile)',
        '\t\t\t\ttell current session of newWindow to write text shellCmd',
        '\t\t\tend tell',
      ],
    });
  }
  if (installedTerminals.has('ghostty')) {
    branches.push({
      id: 'ghostty',
      block: [
        '\t\t\ttell application "Ghostty"',
        '\t\t\t\tactivate',
        '\t\t\t\tset newWin to (new window)',
        '\t\t\t\tdelay 0.2',
        '\t\t\t\tset t to terminal 1 of selected tab of newWin',
        '\t\t\t\tinput text shellCmd to t',
        '\t\t\t\tsend key "enter" to t',
        '\t\t\tend tell',
      ],
    });
  }

  const lines = [];
  branches.forEach((b, i) => {
    const keyword = i === 0 ? 'if' : 'else if';
    lines.push(`\t\t${keyword} theTerminal is "${b.id}" then`);
    lines.push(...b.block);
  });

  // Fallback: any terminal we couldn't emit a tell-block for (because the
  // app isn't installed) OR any CLI-driven terminal (alacritty/kitty/warp)
  // falls through to a shell-out that runs the CLI's executeLaunchPlan.
  if (branches.length > 0) {
    lines.push('\t\telse');
  }
  lines.push(
    `\t\t\tdo shell script quoted form of nodeBin & " " & quoted form of cliBin & " url " & quoted form of theURL & " >> " & quoted form of logFile & " 2>&1"`,
  );
  if (branches.length > 0) {
    lines.push('\t\tend if');
  }
  return lines;
}

function renderAppleScript({ nodeBin, cliBin, installedTerminals }) {
  // The applet must run the `tell application "Terminal" to do script ...`
  // (and equivalent for iTerm/Ghostty) *itself* — not via `osascript` spawned
  // from a do-shell-script chain. macOS TCC will not reliably attribute
  // Apple Events sent from `applet -> do shell script -> node -> osascript`
  // back to the applet's bundle identity; the request is denied with -1743
  // "Not authorized" and the user never sees a permission prompt.
  //
  // Architecture:
  //   1. Applet shells to `syntaur url --print-plan <url>`. The CLI returns
  //      a two-line plan: terminal id on line 1, the cd-and-run shell command
  //      on line 2. No Apple Events involved on this hop.
  //   2. Applet parses the two lines and dispatches to a per-terminal
  //      `tell application <name> to ...` block *inside the applet's own
  //      AppleScript scope*. That makes the applet the responsible process
  //      for the Apple Event, so macOS prompts the user once and grants
  //      Automation permission to the applet.
  //
  // Every shell-command interpolation uses `quoted form of` so paths with
  // spaces or shell metacharacters are safe.
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
    '\t\tdo shell script "/bin/mkdir -p " & quoted form of logDir',
    '\tend try',
    '',
    '\t-- Step 1: ask the CLI for the launch plan (two lines: terminal, shellCmd).',
    '\tset planOutput to ""',
    '\ttry',
    `\t\tset planOutput to (do shell script quoted form of nodeBin & " " & quoted form of cliBin & " url --print-plan " & quoted form of theURL & " 2>> " & quoted form of logFile)`,
    '\ton error errMsg number errNum',
    '\t\ttry',
    `\t\t\tdo shell script "/usr/bin/printf '%s\\\\n' " & quoted form of ("syntaur:// plan resolution failed for " & theURL & ": " & errMsg & " (" & errNum & ")") & " >> " & quoted form of logFile`,
    '\t\tend try',
    '\t\treturn',
    '\tend try',
    '',
    '\t-- Step 2: parse the two-line plan. `paragraphs of` splits on CR/LF.',
    '\tset planLines to paragraphs of planOutput',
    '\tif (count of planLines) < 2 then',
    '\t\ttry',
    `\t\t\tdo shell script "/usr/bin/printf '%s\\\\n' " & quoted form of ("syntaur:// plan output malformed (expected 2 lines, got " & (count of planLines) & "): " & planOutput) & " >> " & quoted form of logFile`,
    '\t\tend try',
    '\t\treturn',
    '\tend if',
    '\tset theTerminal to item 1 of planLines',
    '\tset shellCmd to item 2 of planLines',
    '',
    '\t-- Step 3: dispatch to a per-terminal block. The `tell application`',
    "\t-- below runs in the applet's own AppleScript scope, so macOS TCC",
    '\t-- attributes the resulting Apple Event to the applet (signed bundle',
    '\t-- with CFBundleIdentifier app.syntaur.url-handler).',
    '\ttry',
    ...buildTerminalDispatch(installedTerminals),
    '\ton error errMsg number errNum',
    '\t\ttry',
    `\t\t\tdo shell script "/usr/bin/printf '%s\\\\n' " & quoted form of ("syntaur:// launch failed for " & theURL & " (terminal=" & theTerminal & "): " & errMsg & " (" & errNum & ")") & " >> " & quoted form of logFile`,
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
