import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  readSnoozes,
  setSnooze,
  clearSnooze,
  pruneSnoozes,
  writeSnoozes,
} from '../inbox/snooze.js';

let dir: string;
let path: string;
const NOW = Date.parse('2026-06-16T12:00:00Z');

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'syntaur-snooze-'));
  path = join(dir, 'inbox-snoozes.json');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('readSnoozes', () => {
  it('returns {} for a missing file', async () => {
    expect(await readSnoozes(path, NOW)).toEqual({});
  });

  it('returns {} for malformed JSON', async () => {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(path, '{not json', 'utf-8');
    expect(await readSnoozes(path, NOW)).toEqual({});
  });

  it('drops expired until entries', async () => {
    await writeSnoozes(path, {
      k1: {
        until: '2026-06-01T00:00:00Z',
        fingerprint: 'fp',
        createdAt: '2026-06-01T00:00:00Z',
      },
    });
    expect(await readSnoozes(path, NOW)).toEqual({});
  });

  it('drops entries missing fingerprint or with non-string until', async () => {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(
      path,
      JSON.stringify({
        bad1: { until: null, createdAt: '2026-06-16T00:00:00Z' },
        bad2: { fingerprint: 'fp', until: 7, createdAt: '2026-06-16T00:00:00Z' },
        good: {
          until: '2026-06-20T00:00:00Z',
          fingerprint: 'fp',
          createdAt: '2026-06-16T00:00:00Z',
        },
      }),
      'utf-8',
    );
    const map = await readSnoozes(path, NOW);
    expect(Object.keys(map)).toEqual(['good']);
  });
});

describe('setSnooze / clearSnooze / pruneSnoozes', () => {
  const entry = {
    until: '2026-06-20T00:00:00Z',
    fingerprint: 'fp',
    createdAt: '2026-06-16T00:00:00Z',
  };

  it('writes atomically and round-trips', async () => {
    await setSnooze(path, 'row-1', entry, NOW);
    const raw = await readFile(path, 'utf-8');
    expect(JSON.parse(raw)).toEqual({ 'row-1': entry });
    expect(await readSnoozes(path, NOW)).toEqual({ 'row-1': entry });
  });

  it('clearSnooze returns true then false', async () => {
    await setSnooze(path, 'row-1', entry, NOW);
    expect(await clearSnooze(path, 'row-1', NOW)).toBe(true);
    expect(await readSnoozes(path, NOW)).toEqual({});
    expect(await clearSnooze(path, 'row-1', NOW)).toBe(false);
  });

  it('pruneSnoozes drops only named keys', async () => {
    await setSnooze(path, 'a', entry, NOW);
    await setSnooze(path, 'b', entry, NOW);
    await pruneSnoozes(path, ['a'], NOW);
    expect(await readSnoozes(path, NOW)).toEqual({ b: entry });
  });
});
