import { Command } from 'commander';
import { runCommand, SyntaurError } from '../errors.js';
import { daemonRequest } from '../daemon/index.js';
import type { DispatchReply, ErrorReply } from '../daemon/types.js';

// The `--` tail is spliced out of process.argv before commander parses (see
// src/index.ts), so it can't arrive as a commander positional. index.ts hands
// it to us via this setter, mirroring the capture-command precedent.
let dashDashArgv: string[] = [];
export function setBgDashDashArgv(argv: string[]): void {
  dashDashArgv = argv;
}

export const bgCommand = new Command('bg')
  .description('Run a command as a background PTY session managed by the daemon')
  .option('--name <name>', 'Friendly name for the session')
  .option('--cols <n>', 'Initial terminal columns', '80')
  .option('--rows <n>', 'Initial terminal rows', '24')
  .option('--scrollback <n>', 'Emulator scrollback lines (default 1000, max 100000)')
  .argument('[argv...]', 'Command to run (prefer `-- <cmd> [args]`)')
  .action(
    runCommand(async (positional: string[], opts: { name?: string; cols: string; rows: string; scrollback?: string }) => {
      const argv = dashDashArgv.length > 0 ? dashDashArgv : positional;
      if (!argv || argv.length === 0) {
        throw new SyntaurError('`syntaur bg` needs a command to run.', {
          remediation: 'Pass it after `--`, e.g. `syntaur bg -- codex` or `syntaur bg --name build -- npm run build`.',
        });
      }
      const reply = (await daemonRequest({
        op: 'dispatch',
        argv,
        cwd: process.cwd(),
        name: opts.name,
        cols: Number(opts.cols) || 80,
        rows: Number(opts.rows) || 24,
        // Pass the raw parsed number through; the daemon validates + clamps it.
        ...(opts.scrollback !== undefined ? { scrollback: Number(opts.scrollback) } : {}),
      })) as DispatchReply | ErrorReply;
      if (!reply.ok) {
        throw new SyntaurError(`dispatch failed: ${reply.error}`, {
          remediation: 'Inspect `syntaur daemon logs`.',
        });
      }
      // stdout: the short id (scriptable); stderr: the human hint.
      console.log(reply.short);
      console.error(`session ${reply.short} started (pid ${reply.pid}) — attach with: syntaur attach ${reply.short}`);
    }),
  );
