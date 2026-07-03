// 1000 = button tracking, 1002 = drag tracking, 1006 = SGR extended coords.
const SEQUENCES = ['\x1b[?1000', '\x1b[?1002', '\x1b[?1006'];
export function enableMouseTracking(write: (s: string) => void): void {
  for (const s of SEQUENCES) write(`${s}h`);
}
export function disableMouseTracking(write: (s: string) => void): void {
  for (const s of [...SEQUENCES].reverse()) write(`${s}l`);
}

/**
 * Tear down mouse tracking, run a terminal-suspending action (e.g. handing the
 * TTY to tmux via Ink's `suspendTerminal`), then re-arm tracking once it
 * resumes. Required because Ink's resume does NOT re-run the MouseProvider
 * mount effect and tmux resets the terminal's mouse-tracking DEC private modes,
 * so without this the cockpit comes back mouse-dead. `enableMouseTracking` runs
 * in a `finally`, so a failed/rejected suspend never leaves mouse input off.
 */
export async function runWithMouseSuspended(
  write: (s: string) => void,
  suspend: () => Promise<void>,
): Promise<void> {
  disableMouseTracking(write);
  try {
    await suspend();
  } finally {
    enableMouseTracking(write);
  }
}
