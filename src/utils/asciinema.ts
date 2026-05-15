import { spawn, type StdioOptions } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface CaptureAsciinemaOptions {
  commandArgv?: string[];
}

export interface CaptureAsciinemaResult {
  castPath: string;
  cleanup: () => Promise<void>;
  nonZeroExit: boolean;
  exitCode: number;
}

const SAFE_RE = /^[A-Za-z0-9_@%+=:,./-]+$/;

export function shellQuote(s: string): string {
  if (s.length === 0) return `''`;
  if (SAFE_RE.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export function joinCommandForShell(argv: string[]): string {
  return argv.map(shellQuote).join(' ');
}

// A cast is "non-empty" iff it contains at least one recorded input ('i') or
// output ('o') event past the header. Resize ('r'), marker ('m'), and exit
// ('x') events alone count as empty per AC4. Tolerates v3 comment lines and
// a truncated final line (e.g. abort mid-write).
export function hasRecordedData(text: string): boolean {
  const lines = text.split('\n');
  for (let i = 1; i < lines.length; i++) {
    const raw = lines[i];
    if (raw === '') continue;
    if (raw.startsWith('#')) continue;
    if (/^\s*\[\s*[\d.eE+-]+\s*,\s*"([oi])"/.test(raw)) return true;
  }
  return false;
}

function runAsciinema(args: string[], stdio: StdioOptions): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('asciinema', args, { stdio });
    let settled = false;
    child.once('error', (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
    child.once('close', (code) => {
      if (settled) return;
      settled = true;
      resolvePromise(code ?? -1);
    });
  });
}

export async function captureAsciinema(
  opts: CaptureAsciinemaOptions,
): Promise<CaptureAsciinemaResult> {
  const tmpDir = await mkdtemp(join(tmpdir(), 'syntaur-asciinema-'));
  const castPath = join(tmpDir, 'session.cast');
  const cleanup = async (): Promise<void> => {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  };

  // Suppress the parent's default SIGINT termination while asciinema runs.
  // Ctrl-C in the TTY is delivered to the whole foreground process group:
  // asciinema handles it gracefully and finalizes the cast file, but the
  // parent would otherwise die before we can read the result. A no-op listener
  // overrides Node's default-terminate behavior; asciinema gets to finish, the
  // promise resolves with its exit code, and the normal content-based success
  // check decides whether to attach or throw.
  const noopSigint = (): void => {};
  process.on('SIGINT', noopSigint);

  try {
    const interactive = !opts.commandArgv || opts.commandArgv.length === 0;
    const args = interactive
      ? ['rec', castPath]
      : ['rec', '--command', joinCommandForShell(opts.commandArgv!), castPath];
    const stdio: StdioOptions = interactive
      ? 'inherit'
      : ['ignore', 'inherit', 'inherit'];

    let exitCode: number;
    try {
      exitCode = await runAsciinema(args, stdio);
    } catch (err) {
      if (err && typeof err === 'object' && (err as { code?: string }).code === 'ENOENT') {
        throw new Error(
          'asciinema not found on PATH. Install via "brew install asciinema" or "pipx install asciinema".',
        );
      }
      throw err;
    }

    const text = await readFile(castPath, 'utf8').catch(() => null);
    if (text === null) {
      throw new Error(
        `asciinema produced no cast file at ${castPath} (exit ${exitCode}). ` +
          `Try running 'asciinema rec ${castPath}' directly to diagnose.`,
      );
    }
    if (!hasRecordedData(text)) {
      throw new Error(
        'asciinema produced no recording (canceled before any input was recorded).',
      );
    }

    return {
      castPath,
      cleanup,
      nonZeroExit: exitCode !== 0,
      exitCode,
    };
  } catch (err) {
    await cleanup();
    throw err;
  } finally {
    process.removeListener('SIGINT', noopSigint);
  }
}
