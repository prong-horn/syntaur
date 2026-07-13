#!/usr/bin/env node
// node-pty 1.1.0 ships its prebuilt `spawn-helper` (the exec shim it
// posix_spawnp's on unix) with mode 0644 in the darwin prebuild tarballs, so a
// fresh install leaves it non-executable and `pty.fork` dies with
// "posix_spawnp failed". Restore the execute bit after install so node-pty
// works under `npm install` AND the globally linked binary (Phase-A / AC-6).
//
// Idempotent and best-effort: a no-op when node-pty or the platform helper is
// absent (e.g. Windows uses conpty, which has no spawn-helper), and never
// throws — it must not fail the enclosing `npm install`.
import { chmodSync, existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const helper = join(
  rootDir,
  'node_modules',
  'node-pty',
  'prebuilds',
  `${process.platform}-${process.arch}`,
  'spawn-helper',
);

if (existsSync(helper)) {
  try {
    const mode = statSync(helper).mode;
    const withExec = mode | 0o111;
    if (withExec !== mode) {
      chmodSync(helper, withExec);
    }
  } catch {
    // best-effort; a chmod failure must not break the install
  }
}
