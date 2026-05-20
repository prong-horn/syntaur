#!/usr/bin/env node
/**
 * Register `syntaur://` as a URL scheme handler on macOS.
 *
 * Two call sites:
 *   - Postinstall hook (npm runs `node scripts/install-macos-url-handler.mjs`):
 *     uses the bottom-of-file `main()` wrapper which calls
 *     `registerMacosUrlHandler({ throwOnFailure: false })` and swallows
 *     everything so `npm install` never fails on URL-scheme registration.
 *   - `syntaur install-url-handler` subcommand: dynamic-imports this module
 *     and calls `registerMacosUrlHandler({ throwOnFailure: true })` so any
 *     `osacompile`/`codesign`/`lsregister` failure surfaces loudly.
 *
 * Implementation: builds an AppleScript applet (`.app` bundle) that
 * LaunchServices routes incoming `syntaur://...` URLs to via the standard
 * `on open location` Apple Event handler, then runs `lsregister -f` to
 * register it. See the renderAppleScript docstring for the routing flow.
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
 * Concurrency: both call sites can fire simultaneously (e.g. user has the
 * subcommand open in one terminal while `npm install -g syntaur` runs in
 * another). The bundle path is shared, so we acquire an exclusive lockfile
 * at `~/.syntaur/install-url-handler.lock` via `fs.openSync(path, 'wx')`
 * before touching the bundle directory and release it in `finally`.
 *
 * No-op on non-darwin platforms (returns `{ bundlePath: '' }` under
 * `throwOnFailure: false`; throws under `true`).
 */

import {
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  realpathSync,
  openSync,
  closeSync,
  unlinkSync,
} from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const BUNDLE_ID = 'app.syntaur.url-handler';
const BUNDLE_NAME = 'Syntaur URL Handler';
const URL_SCHEME = 'syntaur';
const LSREGISTER = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';
const OSACOMPILE = '/usr/bin/osacompile';

/**
 * Mirror of `src/utils/paths.ts:syntaurRoot()`. Replicated here because the
 * postinstall .mjs cannot reach into compiled TS — at postinstall time
 * `dist/` may not exist yet on a fresh clone.
 */
function syntaurRootMjs() {
  const override = process.env.SYNTAUR_HOME;
  if (override && override.length > 0) {
    return override;
  }
  return join(homedir(), '.syntaur');
}

/**
 * Register the syntaur:// URL handler on macOS.
 *
 * @param {{ throwOnFailure: boolean }} options
 *   throwOnFailure: when true (subcommand path), any non-zero exit from
 *   osacompile/codesign/lsregister throws and a non-darwin platform throws.
 *   When false (postinstall path), failures degrade to console.warn and the
 *   function returns with bundlePath: ''.
 * @returns {Promise<{ bundlePath: string }>}
 */
export async function registerMacosUrlHandler(options = { throwOnFailure: false }) {
  const { throwOnFailure } = options;

  if (process.platform !== 'darwin') {
    if (throwOnFailure) {
      throw new Error(
        'macOS-only: syntaur:// URL handler registration is only supported on darwin.',
      );
    }
    return { bundlePath: '' };
  }

  // Acquire the cross-process lock before touching the shared bundle path.
  // `wx` flag = O_CREAT | O_EXCL — open fails with EEXIST if the file is
  // already there, which is exactly the "another registration in progress"
  // signal we want. The stale-lock case (process crashed mid-registration)
  // is left to manual cleanup; surfacing the lock path in the error message
  // makes that obvious to the user.
  const stateRoot = syntaurRootMjs();
  mkdirSync(stateRoot, { recursive: true });
  const lockPath = resolve(stateRoot, 'install-url-handler.lock');

  let lockFd;
  try {
    lockFd = openSync(lockPath, 'wx');
  } catch (err) {
    if (err && err.code === 'EEXIST') {
      const msg = `Another syntaur:// handler registration is in progress (lock at ${lockPath}). Wait for it to finish or remove the stale lock.`;
      if (throwOnFailure) {
        throw new Error(msg);
      }
      console.warn(`syntaur: skipping macOS URL-handler registration (${msg})`);
      return { bundlePath: '' };
    }
    throw err;
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
    //    osacompile failure is always fatal: registration is impossible
    //    without the bundle, so we throw regardless of `throwOnFailure`.
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
    //
    // The Delete entries strip osacompile's kitchen-sink default
    // NSXxxxUsageDescription keys — its applet template declares purpose
    // strings for HomeKit/Photos/Camera/AppleMusic/Reminders/Siri/etc. so
    // that ANY applet *could* request those permissions. We only need
    // NSAppleEventsUsageDescription (for `tell application ...`); the rest
    // would surface as scary "this app wants access to ..." entries in
    // System Settings → Privacy & Security and serve no purpose for a URL
    // handler. The Deletes are guarded by `null` fallbacks so missing keys
    // are not fatal.
    runPlistBuddy(infoPlistPath, [
      [`Add :CFBundleIdentifier string ${BUNDLE_ID}`, `Set :CFBundleIdentifier ${BUNDLE_ID}`],
      [`Add :CFBundleName string ${BUNDLE_NAME}`, `Set :CFBundleName ${BUNDLE_NAME}`],
      ['Add :LSUIElement bool true', 'Set :LSUIElement true'],
      // Replace the generic Apple Events string with one that names what
      // this app actually does, so the prompt the user sees is meaningful.
      // PlistBuddy Set on a string with an apostrophe/space mix is unreliable;
      // Delete-then-Add is the safe pattern.
      ['Delete :NSAppleEventsUsageDescription', null],
      [
        'Add :NSAppleEventsUsageDescription string Syntaur is opening your configured terminal at the assignment worktree.',
        null,
      ],
      ['Delete :NSHomeKitUsageDescription', null],
      ['Delete :NSAppleMusicUsageDescription', null],
      ['Delete :NSCalendarsUsageDescription', null],
      ['Delete :NSSiriUsageDescription', null],
      ['Delete :NSCameraUsageDescription', null],
      ['Delete :NSMicrophoneUsageDescription', null],
      ['Delete :NSContactsUsageDescription', null],
      ['Delete :NSPhotoLibraryUsageDescription', null],
      ['Delete :NSRemindersUsageDescription', null],
      ['Delete :NSSystemAdministrationUsageDescription', null],
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
      const msg = `codesign returned ${sign.status} while re-signing ${bundlePath}: ${sign.stderr || sign.stdout || '(no output)'}`;
      if (throwOnFailure) {
        throw new Error(msg);
      }
      console.warn(`syntaur: ${msg} — macOS may deny Automation permission.`);
    }

    // 5. Register with LaunchServices so the OS routes syntaur:// URLs here.
    //    Switched stdio to 'pipe' (was 'ignore') so we can include lsregister's
    //    own diagnostic in failure messages — postinstall used to drop it.
    const ls = spawnSync(LSREGISTER, ['-f', bundlePath], {
      stdio: 'pipe',
      encoding: 'utf-8',
    });
    if (ls.status !== 0) {
      const msg = `lsregister returned ${ls.status} while registering ${bundlePath}: ${ls.stderr || ls.stdout || '(no output)'}`;
      if (throwOnFailure) {
        throw new Error(msg);
      }
      console.warn(
        `syntaur: ${msg} — \`open syntaur://...\` may not route through the CLI handler until you run \`${LSREGISTER} -f ${bundlePath}\` manually.`,
      );
    }

    // 6. Clean up the temp source file.
    try { rmSync(scriptPath); } catch { /* not fatal */ }

    return { bundlePath };
  } finally {
    // Release the lock — both close and unlink wrapped so cleanup never throws.
    try { closeSync(lockFd); } catch { /* not fatal */ }
    try { unlinkSync(lockPath); } catch { /* not fatal */ }
  }
}

/**
 * Postinstall thin wrapper — preserves byte-identical behavior from before
 * the export refactor: catches everything, prints a warning, exits 0.
 */
async function main() {
  try {
    await registerMacosUrlHandler({ throwOnFailure: false });
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
    // Ghostty's AppleScript dictionary doesn't expose `new window`/`terminal`/
    // `input text` verbs — those calls fail at runtime ("can't get terminal 1"
    // / "Can't make new window into integer"). Drive Ghostty via synthesized
    // key events through System Events instead: activate the app, press Cmd-N
    // to open a new window, type the command, then press Return.
    //
    // Requires Accessibility permission for the applet bundle. macOS prompts
    // the first time we synthesize keystrokes; the user grants it once.
    branches.push({
      id: 'ghostty',
      block: [
        '\t\t\ttell application "Ghostty" to activate',
        '\t\t\tdelay 0.3',
        '\t\t\ttell application "System Events"',
        '\t\t\t\tkeystroke "n" using command down',
        '\t\t\t\tdelay 0.4',
        '\t\t\t\tkeystroke shellCmd',
        '\t\t\t\tkey code 36',
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

// Only run main() when this file is executed directly (e.g. via the npm
// postinstall hook), NOT when it's dynamic-imported by the TS subcommand.
// Without this guard, `await import(...)` from the subcommand would trigger
// a second silent registration on import-time before the throw-mode call.
// pathToFileURL handles cross-platform path-to-URL normalization (matters on
// Windows where argv[1] uses backslashes).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
