// Reusable pty-host arg parsing + run function, with NO module side effects, so
// it can be imported freely (the barrel, the hidden `syntaur pty-host` command)
// without triggering a run. The actual process entry point is pty-host-main.ts,
// which is a thin wrapper that nothing imports — keeping this auto-run code out
// of the bundled `dist/index.js` (where an is-main guard is unreliable because
// the bundle rewrites import.meta.url to index.js).

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
