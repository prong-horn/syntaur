import { spawnSync } from 'node:child_process';

/**
 * Copy text to the system clipboard. Currently darwin-only (`pbcopy`); a graceful
 * no-op returning `false` on other platforms or on any failure. Never throws.
 */
export function copyToClipboard(text: string): boolean {
  if (process.platform !== 'darwin') return false;
  try {
    const r = spawnSync('pbcopy', [], { input: text });
    return r.status === 0;
  } catch {
    return false;
  }
}
