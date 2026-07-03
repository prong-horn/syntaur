import chokidar, { type FSWatcher } from 'chokidar';
import { openSync, readSync, fstatSync, closeSync, existsSync } from 'node:fs';

export interface TailHandle { stop(): void; }
export interface TailOptions {
  path: string;
  maxInitialLines?: number;
  onLines: (lines: string[]) => void;
  onError?: (err: Error) => void;
}

function readFrom(path: string, offset: number): { text: string; next: number } {
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size;
    if (size <= offset) return { text: '', next: size };
    const buf = Buffer.alloc(size - offset);
    readSync(fd, buf, 0, size - offset, offset);
    return { text: buf.toString('utf8'), next: size };
  } finally {
    closeSync(fd);
  }
}

export function tailFile(opts: TailOptions): TailHandle {
  const maxInitial = opts.maxInitialLines ?? 200;
  let offset = 0;
  let carry = '';

  if (!existsSync(opts.path)) {
    opts.onError?.(new Error(`transcript not found: ${opts.path}`));
    return { stop() {} };
  }

  const emit = (initial: boolean) => {
    try {
      const { text, next } = readFrom(opts.path, offset);
      offset = next;
      if (!text) return;
      const parts = (carry + text).split('\n');
      carry = parts.pop() ?? '';
      let lines = parts;
      if (initial && lines.length > maxInitial) lines = lines.slice(-maxInitial);
      if (lines.length) opts.onLines(lines);
    } catch (err) {
      opts.onError?.(err as Error);
    }
  };

  emit(true);
  const watcher: FSWatcher = chokidar.watch(opts.path, { ignoreInitial: true });
  watcher.on('change', () => emit(false));
  watcher.on('error', (err) => opts.onError?.(err as Error));
  return { stop() { void watcher.close(); } };
}
