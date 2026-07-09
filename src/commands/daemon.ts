import { Command } from 'commander';
import { runCommand, SyntaurError } from '../errors.js';
import { createDaemon, sendRequest, tailLog } from '../daemon/index.js';
import { resolveDaemon } from '../daemon/discovery.js';
import { currentPointerPath } from '../daemon/paths.js';
import type { ControlReply, ControlRequest, StatusReply } from '../daemon/types.js';

/** Send a control request only if a daemon is already live (never auto-starts). */
async function requestExisting(req: ControlRequest): Promise<ControlReply | null> {
  const pointer = await resolveDaemon(currentPointerPath());
  if (!pointer) return null;
  return sendRequest(pointer.controlSock, req);
}

function printStatus(reply: StatusReply): void {
  console.log(`daemon ${reply.daemonId} (pid ${reply.pid}), started ${reply.startedAt || 'unknown'}`);
  console.log(`${reply.sessions.length} session(s)`);
  for (const s of reply.sessions) {
    const name = s.name ? ` "${s.name}"` : '';
    console.log(`  ${s.short}  ${s.state.padEnd(8)} ${s.agent}  pid=${s.pid}${name}`);
  }
}

const runSub = new Command('run')
  .description('Run the daemon supervisor in the foreground (normally auto-started)')
  .action(
    runCommand(async () => {
      const daemon = createDaemon();
      const result = await daemon.start();
      if (result === 'yielded') {
        // Another live daemon owns the lock/socket — nothing to do.
        process.exit(0);
      }
      let stopping = false;
      const shutdown = async (): Promise<void> => {
        if (stopping) return;
        stopping = true;
        await daemon.stop();
        process.exit(0);
      };
      process.on('SIGINT', () => void shutdown());
      process.on('SIGTERM', () => void shutdown());
      // The control server keeps the event loop alive; sessions outlive us.
    }),
  );

const statusSub = new Command('status')
  .description('Show the daemon status and its sessions')
  .option('--json', 'Output JSON')
  .action(
    runCommand(async (opts: { json?: boolean }) => {
      const reply = await requestExisting({ op: 'status' });
      if (!reply) {
        if (opts.json) console.log(JSON.stringify({ running: false, sessions: [] }));
        else console.log('daemon: not running');
        return;
      }
      if (!reply.ok) throw new SyntaurError(`daemon status failed: ${reply.error}`, { remediation: 'Check ~/.syntaur/daemon.log.' });
      if (opts.json) console.log(JSON.stringify(reply, null, 2));
      else printStatus(reply as StatusReply);
    }),
  );

const logsSub = new Command('logs')
  .description('Tail the daemon log (~/.syntaur/daemon.log)')
  .option('-n, --lines <n>', 'Number of lines to show', '50')
  .action(
    runCommand(async (opts: { lines: string }) => {
      const lines = tailLog(Number(opts.lines) || 50);
      if (lines.length === 0) console.log('(no daemon log yet)');
      else console.log(lines.join('\n'));
    }),
  );

const stopSub = new Command('stop')
  .description('Stop the daemon (sessions keep running)')
  .action(
    runCommand(async () => {
      const reply = await requestExisting({ op: 'stop' });
      if (!reply) {
        console.log('daemon: not running');
        return;
      }
      if (!reply.ok) throw new SyntaurError(`daemon stop failed: ${reply.error}`, { remediation: 'Check ~/.syntaur/daemon.log.' });
      console.log('daemon: stopped (sessions keep running)');
    }),
  );

export const daemonCommand = new Command('daemon')
  .description('Manage the Syntaur background-session daemon')
  .addCommand(runSub)
  .addCommand(statusSub)
  .addCommand(logsSub)
  .addCommand(stopSub);
