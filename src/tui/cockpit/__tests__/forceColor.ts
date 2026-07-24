// Force chalk/ink to emit ANSI color (including SGR 7 inverse) even under a
// colorless runner. Imported FIRST — before `ink-testing-library` — by the
// cockpit render tests that assert on inverse-video escape codes.
//
// Why this exists: on a GitHub Actions runner (no TTY, no color support) chalk
// resolves to level 0, so Ink strips every SGR code — the `[7m` an inverse
// row/chip renders to simply isn't in `lastFrame()`, and the assertions fail
// even though the component is correct. It passes locally only because a dev
// terminal has color on. Setting FORCE_COLOR before `supports-color` first
// evaluates pins color on for these tests regardless of environment.
//
// Deliberately NOT a global setup file: vitest runs each test file in an
// isolated fork, but a global FORCE_COLOR would apply in every fork and leak
// into the subprocess CLI tests (which spawn the built binary and assert on
// plain-text output). Scoping it to the two render-assertion files keeps it off
// everything else. These files spawn no subprocess.
process.env.FORCE_COLOR = '3';

export {};
