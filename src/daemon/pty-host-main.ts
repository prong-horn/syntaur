// Dedicated pty-host process entry. The daemon spawns this directly via
// `process.execPath dist/daemon/pty-host-main.js <flags> -- <argv>` (Decision 3:
// booting the full commander tree per session is wasteful).
//
// NOTHING imports this module — the reusable logic lives in pty-host-run.ts.
// Keeping the auto-run isolated here means it is never pulled into the bundled
// dist/index.js, where an is-main guard would misfire (the bundle rewrites
// import.meta.url to index.js, matching argv[1] for any `syntaur` invocation).

import { runPtyHostMain } from './pty-host-run.js';

runPtyHostMain(process.argv.slice(2)).catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
