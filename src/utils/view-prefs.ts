import { readFile, rename, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { syntaurRoot, viewPrefsFile } from './paths.js';
import { fileExists, writeFileForce } from './fs.js';
import {
  DEFAULT_VIEW_PREFS_FILE,
  type ViewPrefsFile,
  type ViewPrefsPatch,
  mergePatch,
  toFilterValues,
} from './view-prefs-schema.js';

// Re-exports so consumers only need to import from this module.
export type { ViewPrefsFile, ViewPrefsPatch };
export { mergePatch } from './view-prefs-schema.js';
export { mergeForScope } from './view-prefs-schema.js';

function corruptFilePath(): string {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  return resolve(syntaurRoot(), `view-prefs.corrupt-${ts}.json`);
}

function isViewPrefsFileShape(value: unknown): value is ViewPrefsFile {
  if (!value || typeof value !== 'object') return false;
  const obj = value as Record<string, unknown>;
  // Treat missing `version` as v1 (forward-compat with previously-written files).
  // An explicit non-1 version is handled separately upstream.
  if (obj.version !== undefined && obj.version !== 1) return false;
  if (!obj.global || typeof obj.global !== 'object') return false;
  if (!obj.projects || typeof obj.projects !== 'object' || Array.isArray(obj.projects)) {
    return false;
  }
  return true;
}

// Returns the parsed file when readable + valid.
// Returns defaults on missing, parse error, or shape mismatch.
// On corruption (present but unparseable / bad shape), renames the bad file
// to view-prefs.corrupt-<ISO>.json BEFORE returning defaults so the next save
// does not overwrite the evidence. Unknown future versions return defaults
// WITHOUT renaming (forward-compat).
export async function readViewPrefsFile(): Promise<ViewPrefsFile> {
  const path = viewPrefsFile();
  if (!(await fileExists(path))) {
    return { ...DEFAULT_VIEW_PREFS_FILE };
  }
  let raw: string;
  try {
    raw = await readFile(path, 'utf-8');
  } catch {
    return { ...DEFAULT_VIEW_PREFS_FILE };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    await backupCorrupt(path);
    return { ...DEFAULT_VIEW_PREFS_FILE };
  }
  if (parsed && typeof parsed === 'object' && (parsed as Record<string, unknown>).version !== undefined) {
    const v = (parsed as Record<string, unknown>).version;
    if (typeof v === 'number' && v > 1) {
      console.warn(
        `[view-prefs] Unknown version ${v} at ${path}; returning defaults (file left intact).`,
      );
      return { ...DEFAULT_VIEW_PREFS_FILE };
    }
  }
  if (!isViewPrefsFileShape(parsed)) {
    await backupCorrupt(path);
    return { ...DEFAULT_VIEW_PREFS_FILE };
  }
  // Normalize version (missing -> 1).
  return { ...parsed, version: 1 };
}

async function backupCorrupt(path: string): Promise<void> {
  const backup = corruptFilePath();
  try {
    await rename(path, backup);
    console.warn(`[view-prefs] Corrupt file moved to ${backup}; using defaults.`);
  } catch (err) {
    console.warn(`[view-prefs] Failed to back up corrupt file ${path}: ${String(err)}`);
  }
}

export async function writeViewPrefsFile(file: ViewPrefsFile): Promise<void> {
  await writeFileForce(viewPrefsFile(), `${JSON.stringify(file, null, 2)}\n`);
}

export async function resetViewPrefsFile(): Promise<void> {
  const path = viewPrefsFile();
  if (await fileExists(path)) {
    await unlink(path);
  }
}

// Convenience for routes: read → mergePatch → write.
export async function applyViewPrefsPatch(patch: ViewPrefsPatch): Promise<ViewPrefsFile> {
  const current = await readViewPrefsFile();
  const next = mergePatch(current, patch);
  await writeViewPrefsFile(next);
  return next;
}

export function isViewPrefsDefaults(file: ViewPrefsFile): boolean {
  if (Object.keys(file.projects).length > 0) return false;
  const g = file.global;
  const d = DEFAULT_VIEW_PREFS_FILE.global;
  if (g.defaultView !== d.defaultView) return false;
  if (g.sortField !== d.sortField) return false;
  if (g.sortDirection !== d.sortDirection) return false;
  if (g.density !== d.density) return false;
  if (g.grouping !== d.grouping) return false;
  // Compare NORMALIZED filter semantics, not raw scalar equality: once filters
  // can be arrays, `status: []` / `'all'` / absent are all "default", and a
  // populated array is "custom". Raw `!==` would misclassify these.
  const gf = g.filters;
  for (const key of ['status', 'type', 'priority', 'assignee', 'project', 'tags'] as const) {
    if (toFilterValues(gf[key]).length > 0) return false;
  }
  if (gf.activity !== undefined && gf.activity !== 'all') return false;
  return true;
}
