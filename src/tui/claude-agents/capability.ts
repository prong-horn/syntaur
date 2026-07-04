import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type ProbeFn = () => Promise<unknown>;

const defaultProbe: ProbeFn = () =>
  execFileAsync('claude', ['agents', '--json'], { timeout: 5000, maxBuffer: 8 * 1024 * 1024 });

// Native background-agent support rarely changes over the process lifetime,
// but the probe is a real fork+exec — cache it process-wide, mirroring
// `checkTmuxAvailable` (`src/dashboard/scanner.ts`). Never rejects: any probe
// failure (binary missing, old CLI without `--bg`/`agents --json`) resolves
// to `false` so callers degrade to the tmux path.
let cache: Promise<boolean> | null = null;

export async function checkClaudeBgAvailable(probe: ProbeFn = defaultProbe): Promise<boolean> {
  if (!cache) {
    cache = probe().then(() => true).catch(() => false);
  }
  return cache;
}

/** Test-only: clear the memoized capability probe between cases. */
export function resetClaudeBgAvailableCache(): void {
  cache = null;
}
