import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { tailFile } from '../transcript.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(resolve(tmpdir(), 'syntaur-tail-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const waitFor = (pred: () => boolean, ms = 2000) =>
  new Promise<void>((res, rej) => {
    const start = Date.now();
    const iv = setInterval(() => {
      if (pred()) { clearInterval(iv); res(); }
      else if (Date.now() - start > ms) { clearInterval(iv); rej(new Error('timeout')); }
    }, 20);
  });

describe('tailFile', () => {
  it('emits existing lines then appended lines', async () => {
    const p = resolve(dir, 't.jsonl');
    writeFileSync(p, 'line1\nline2\n');
    const seen: string[] = [];
    const h = tailFile({ path: p, onLines: (ls) => seen.push(...ls) });
    await waitFor(() => seen.includes('line2'));
    appendFileSync(p, 'line3\n');
    await waitFor(() => seen.includes('line3'));
    h.stop();
    expect(seen).toEqual(['line1', 'line2', 'line3']);
  });
  it('reports a missing file via onError without throwing', async () => {
    let err: Error | null = null;
    const h = tailFile({ path: resolve(dir, 'nope.jsonl'), onLines: () => {}, onError: (e) => (err = e) });
    await waitFor(() => err !== null);
    h.stop();
    expect(err).toBeInstanceOf(Error);
  });
});
