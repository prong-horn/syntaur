// Dedicated pty-host entry point. The daemon spawns this directly via
// `process.execPath dist/daemon/pty-host-main.js <flags> -- <argv>` (Decision 3:
// booting the full commander tree per session is wasteful). The hidden
// `syntaur pty-host` command (Task 5) imports `runPtyHostMain` and reuses it, so
// this module must be import-safe — the CLI auto-run is guarded behind an
// is-main check.

import { pathToFileURL } from 'node:url';
import { SyntaurError } from '../errors.js';
import { runPtyHost, smokePtyHost, type PtyHostConfig } from './pty-host.js';

export interface ParsedPtyHostArgs {
  smoke: boolean;
  config?: PtyHostConfig;
}

/**
 * Parse `--smoke` OR `--short <s> --daemon-id <d> --agent <a> --cwd <p>
 * --cols <n> --rows <n> [--name <s>] [--session-id <s>] -- <file> [args…]`.
 */
export function parsePtyHostArgs(argv: string[]): ParsedPtyHostArgs {
  if (argv.includes('--smoke')) return { smoke: true };

  const dashIdx = argv.indexOf('--');
  const flags = dashIdx === -1 ? argv : argv.slice(0, dashIdx);
  const tail = dashIdx === -1 ? [] : argv.slice(dashIdx + 1);
  const get = (name: string): string | undefined => {
    const i = flags.indexOf(name);
    return i === -1 ? undefined : flags[i + 1];
  };

  const short = get('--short');
  const daemonId = get('--daemon-id');
  if (!short || !daemonId || tail.length === 0) {
    throw new SyntaurError('pty-host requires --short, --daemon-id, and a `-- <argv>` tail.', {
      remediation:
        'Invoke via the daemon (`syntaur bg`); direct use needs --short <id> --daemon-id <id> -- <cmd> [args].',
    });
  }

  const config: PtyHostConfig = {
    short,
    daemonId,
    agent: get('--agent') ?? 'shell',
    argv: tail,
    cwd: get('--cwd') ?? process.cwd(),
    cols: Number(get('--cols') ?? '80'),
    rows: Number(get('--rows') ?? '24'),
    name: get('--name'),
    sessionId: get('--session-id') ?? null,
  };
  return { smoke: false, config };
}

/** Run the pty-host from a raw argv slice (no `syntaur`/`pty-host` prefix). */
export async function runPtyHostMain(argv: string[]): Promise<void> {
  const parsed = parsePtyHostArgs(argv);
  if (parsed.smoke) {
    process.stdout.write(`${smokePtyHost()}\n`);
    return;
  }
  const config = parsed.config as PtyHostConfig;
  process.title = `syntaur pty-host ${config.short}`;
  // Binds pty/rv sockets; the open servers keep the event loop alive until the
  // child exits, at which point onExit tears down and exits the process.
  await runPtyHost(config, { onExit: (code) => process.exit(code) });
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  runPtyHostMain(process.argv.slice(2)).catch((err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
