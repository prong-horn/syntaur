/**
 * Snooze store for the Needs me inbox — one JSON file under the Syntaur home.
 * Pure fs; no dashboard imports.
 *
 * Map keys match `inboxRowKey` in `index.ts`: a chat item id, `<ID>~<compact-ts>`
 * for log question rows, or `<ID>~<category>` for ticket-level rows — no colons.
 */

import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { rename, writeFile } from 'node:fs/promises';
import { syntaurRoot } from '../utils/paths.js';
import { ensureDir } from '../utils/fs.js';
import type { SnoozeEntry, SnoozeMap } from './types.js';

export type { SnoozeEntry, SnoozeMap } from './types.js';

export function snoozeFilePath(): string {
  return resolve(syntaurRoot(), 'inbox-snoozes.json');
}

function isValidEntry(raw: unknown, now: number): SnoozeEntry | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.fingerprint !== 'string') return null;
  if (o.until !== null && typeof o.until !== 'string') return null;
  if (typeof o.createdAt !== 'string') return null;
  if (o.until !== null) {
    const ms = Date.parse(o.until);
    if (Number.isNaN(ms) || ms <= now) return null;
  }
  return { until: o.until as string | null, fingerprint: o.fingerprint, createdAt: o.createdAt };
}

/** Read the snooze map; missing/malformed → `{}`; expired entries dropped. */
export async function readSnoozes(path: string, now: number): Promise<SnoozeMap> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf-8');
  } catch {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
  const result: SnoozeMap = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    const entry = isValidEntry(value, now);
    if (entry) result[key] = entry;
  }
  return result;
}

/** Atomic write via temp file + rename. */
export async function writeSnoozes(path: string, map: SnoozeMap): Promise<void> {
  const dir = dirname(path);
  const tempPath = join(dir, `.${Math.random().toString(36).slice(2)}.${Date.now()}.tmp`);
  await ensureDir(dir);
  await writeFile(tempPath, JSON.stringify(map, null, 2) + '\n', 'utf-8');
  await rename(tempPath, path);
}

export async function setSnooze(
  path: string,
  key: string,
  entry: SnoozeEntry,
  now: number,
): Promise<void> {
  const map = await readSnoozes(path, now);
  map[key] = entry;
  await writeSnoozes(path, map);
}

export async function clearSnooze(path: string, key: string, now: number): Promise<boolean> {
  const map = await readSnoozes(path, now);
  if (!(key in map)) return false;
  delete map[key];
  await writeSnoozes(path, map);
  return true;
}

/** Remove only the named keys from the store. */
export async function pruneSnoozes(path: string, keys: string[], now: number): Promise<void> {
  if (keys.length === 0) return;
  const map = await readSnoozes(path, now);
  let changed = false;
  for (const key of keys) {
    if (key in map) {
      delete map[key];
      changed = true;
    }
  }
  if (changed) await writeSnoozes(path, map);
}
