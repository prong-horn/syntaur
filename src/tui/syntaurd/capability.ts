import { existsSync } from 'node:fs';
import { cliEntryPath } from '../../daemon/paths.js';

export type ProbeFn = () => Promise<unknown>;

// The syntaurd tier's real failure modes are machinery, not liveness: a
// missing built CLI entry (the attach child and ensureDaemon's spawn both
// exec it) or a broken node-pty prebuild. Daemon liveness is deliberately NOT
// probed — dispatch auto-spawns via ensureDaemon, so "not currently running"
// does not mean unavailable, and probing liveness would flap the ladder.
// pty-host.js is imported DYNAMICALLY: it imports node-pty at top level, so a
// broken native module must reject this probe (→ false) rather than crash the
// cockpit at module-load time.
const defaultProbe: ProbeFn = async () => {
  if (!existsSync(cliEntryPath())) {
    throw new Error(`syntaur CLI entry missing: ${cliEntryPath()}`);
  }
  const { smokePtyHost } = await import('../../daemon/pty-host.js');
  return smokePtyHost();
};

// Cache process-wide, mirroring checkClaudeBgAvailable. Never rejects: any
// probe failure resolves false so callers degrade to the claude-bg/tmux tiers.
let cache: Promise<boolean> | null = null;

export async function checkSyntaurdAvailable(probe: ProbeFn = defaultProbe): Promise<boolean> {
  if (!cache) {
    cache = probe().then(() => true).catch(() => false);
  }
  return cache;
}

/** Test-only: clear the memoized capability probe between cases. */
export function resetSyntaurdAvailableCache(): void {
  cache = null;
}
