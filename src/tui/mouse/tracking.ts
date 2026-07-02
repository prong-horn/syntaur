// 1000 = button tracking, 1002 = drag tracking, 1006 = SGR extended coords.
const SEQUENCES = ['\x1b[?1000', '\x1b[?1002', '\x1b[?1006'];
export function enableMouseTracking(write: (s: string) => void): void {
  for (const s of SEQUENCES) write(`${s}h`);
}
export function disableMouseTracking(write: (s: string) => void): void {
  for (const s of [...SEQUENCES].reverse()) write(`${s}l`);
}
