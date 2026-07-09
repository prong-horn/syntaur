import { Command } from 'commander';
import { runCommand, SyntaurError } from '../errors.js';
import { runPtyHostMain } from '../daemon/pty-host-run.js';

/**
 * Hidden `syntaur pty-host` command. Registered hidden (Decision 1) because a
 * real background session is spawned by the daemon straight through the
 * dedicated `pty-host-main.js` entry (Decision 3) — this command exists only to
 * expose the `--smoke` node-pty prebuild gate (AC-6) through the installed/linked
 * binary's real pty-host code path.
 */
export const ptyHostCommand = new Command('pty-host')
  .description('Internal: background pty-host (spawned by the daemon)')
  .option('--smoke', 'Allocate + destroy a PTY to verify the node-pty prebuild, then exit 0')
  .allowUnknownOption(true)
  .action(
    runCommand(async (opts: { smoke?: boolean }) => {
      if (opts.smoke) {
        await runPtyHostMain(['--smoke']);
        return;
      }
      throw new SyntaurError(
        'Direct `syntaur pty-host` invocation is internal (the daemon spawns pty-hosts itself).',
        { remediation: 'Start a background session with `syntaur bg -- <cmd> [args]`.' },
      );
    }),
  );
