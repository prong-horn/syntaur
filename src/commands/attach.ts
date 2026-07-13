import { Command } from 'commander';
import { connect } from 'node:net';
import { runCommand, SyntaurError } from '../errors.js';
import { daemonRequest, runAttachClient, type AttachDeps } from '../daemon/index.js';
import type { AttachReply, ErrorReply } from '../daemon/types.js';

export const attachCommand = new Command('attach')
  .description('Attach to a background session (detach with Ctrl-] — Ctrl-C goes to the agent)')
  .argument('<short>', 'Session short id (from `syntaur bg` / `syntaur daemon status`)')
  .action(
    runCommand(async (short: string) => {
      const cols = process.stdout.columns ?? 80;
      const rows = process.stdout.rows ?? 24;

      const result = await runAttachClient(
        { short, cols, rows },
        {
          // Control-plane attach op: the daemon validates liveness and returns
          // socket paths; bytes never proxy through control.sock (Decision 6).
          attachOp: async (s, c, r) =>
            (await daemonRequest({ op: 'attach', short: s, cols: c, rows: r })) as AttachReply | ErrorReply,
          connectPty: (sock) => connect(sock) as unknown as ReturnType<AttachDeps['connectPty']>,
        },
      );

      if (result.reason === 'connect-failed') {
        throw new SyntaurError(`could not attach to "${short}": ${result.error?.message ?? 'unavailable'}`, {
          remediation: 'Run `syntaur daemon status` to list live sessions.',
        });
      }
      if (result.reason === 'exit') {
        console.error(`\nsession "${short}" exited${result.code != null ? ` (${result.code})` : ''}`);
      } else {
        console.error(`\ndetached from "${short}"`);
      }
    }),
  );
