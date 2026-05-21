import { readFile, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { syntaurRoot, savedViewsFile } from './paths.js';
import { fileExists, writeFileForce } from './fs.js';
import {
  DEFAULT_SAVED_VIEWS_FILE,
  isDashboardSlot,
  isSavedView,
  type DashboardSlot,
  type SavedView,
  type SavedViewConfig,
  type SavedViewsFile,
} from './saved-views-schema.js';

export type {
  DashboardSlot,
  SavedView,
  SavedViewConfig,
  SavedViewsFile,
} from './saved-views-schema.js';

function corruptFilePath(): string {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  return resolve(syntaurRoot(), `saved-views.corrupt-${ts}.json`);
}

function isSavedViewsFileShape(value: unknown): value is SavedViewsFile {
  if (!value || typeof value !== 'object') return false;
  const obj = value as Record<string, unknown>;
  if (obj.version !== undefined && obj.version !== 1) return false;
  if (!Array.isArray(obj.views)) return false;
  if (!obj.views.every(isSavedView)) return false;
  if (!obj.dashboard || typeof obj.dashboard !== 'object') return false;
  const dash = obj.dashboard as Record<string, unknown>;
  if (dash.version !== undefined && dash.version !== 1) return false;
  if (!Array.isArray(dash.slots)) return false;
  if (!dash.slots.every(isDashboardSlot)) return false;
  return true;
}

function cloneDefault(): SavedViewsFile {
  return JSON.parse(JSON.stringify(DEFAULT_SAVED_VIEWS_FILE)) as SavedViewsFile;
}

// Returns the parsed file when readable + valid.
// Returns defaults on missing, parse error, or shape mismatch.
// On corruption (present but unparseable / bad shape), renames the bad file
// to saved-views.corrupt-<ISO>.json BEFORE returning defaults so the next save
// does not overwrite the evidence. Unknown future versions return defaults
// WITHOUT renaming (forward-compat).
export async function readSavedViewsFile(): Promise<SavedViewsFile> {
  const path = savedViewsFile();
  if (!(await fileExists(path))) {
    return cloneDefault();
  }
  let raw: string;
  try {
    raw = await readFile(path, 'utf-8');
  } catch {
    return cloneDefault();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    await backupCorrupt(path);
    return cloneDefault();
  }
  if (parsed && typeof parsed === 'object' && (parsed as Record<string, unknown>).version !== undefined) {
    const v = (parsed as Record<string, unknown>).version;
    if (typeof v === 'number' && v > 1) {
      console.warn(
        `[saved-views] Unknown version ${v} at ${path}; returning defaults (file left intact).`,
      );
      return cloneDefault();
    }
  }
  if (!isSavedViewsFileShape(parsed)) {
    await backupCorrupt(path);
    return cloneDefault();
  }
  const normalized: SavedViewsFile = {
    ...parsed,
    version: 1,
    dashboard: { ...parsed.dashboard, version: 1 },
  };
  return normalized;
}

async function backupCorrupt(path: string): Promise<void> {
  const backup = corruptFilePath();
  try {
    await rename(path, backup);
    console.warn(`[saved-views] Corrupt file moved to ${backup}; using defaults.`);
  } catch (err) {
    console.warn(`[saved-views] Failed to back up corrupt file ${path}: ${String(err)}`);
  }
}

export async function writeSavedViewsFile(file: SavedViewsFile): Promise<void> {
  await writeFileForce(savedViewsFile(), `${JSON.stringify(file, null, 2)}\n`);
}

export async function resetSavedViewsFile(): Promise<void> {
  const path = savedViewsFile();
  if (await fileExists(path)) {
    await unlink(path);
  }
}

// ---- Pure CRUD helpers ----

export interface CreateSavedViewInput {
  name: string;
  workspace: string | null;
  config: SavedViewConfig;
}

export interface SavedViewMutationOk {
  file: SavedViewsFile;
  view: SavedView;
}

export interface SavedViewMutationNotFound {
  error: 'not-found';
}

export type SavedViewMutationResult = SavedViewMutationOk | SavedViewMutationNotFound;

export function createSavedView(
  file: SavedViewsFile,
  input: CreateSavedViewInput,
  now: () => string = () => new Date().toISOString(),
): SavedViewMutationOk {
  const ts = now();
  const view: SavedView = {
    id: randomUUID(),
    name: input.name,
    workspace: input.workspace,
    config: input.config,
    createdAt: ts,
    updatedAt: ts,
  };
  const next: SavedViewsFile = {
    ...file,
    views: [...file.views, view],
  };
  return { file: next, view };
}

export interface UpdateSavedViewPatch {
  name?: string;
  workspace?: string | null;
  config?: SavedViewConfig;
}

export function updateSavedView(
  file: SavedViewsFile,
  id: string,
  patch: UpdateSavedViewPatch,
  now: () => string = () => new Date().toISOString(),
): SavedViewMutationResult {
  const idx = file.views.findIndex((v) => v.id === id);
  if (idx < 0) return { error: 'not-found' };
  const prev = file.views[idx];
  const updated: SavedView = {
    ...prev,
    name: patch.name ?? prev.name,
    workspace: patch.workspace !== undefined ? patch.workspace : prev.workspace,
    config: patch.config ?? prev.config,
    updatedAt: now(),
  };
  const views = [...file.views];
  views[idx] = updated;
  return { file: { ...file, views }, view: updated };
}

export interface DeleteSavedViewResult {
  file: SavedViewsFile;
  deleted: boolean;
}

export function deleteSavedView(file: SavedViewsFile, id: string): DeleteSavedViewResult {
  const idx = file.views.findIndex((v) => v.id === id);
  if (idx < 0) return { file, deleted: false };
  const views = file.views.filter((v) => v.id !== id);
  // Cascade: null out any dashboard slot referencing this view.
  const slots = file.dashboard.slots.map((s) => {
    if (s.widget && s.widget.kind === 'saved-view' && s.widget.viewId === id) {
      return { ...s, widget: null };
    }
    return s;
  });
  return {
    file: { ...file, views, dashboard: { ...file.dashboard, slots } },
    deleted: true,
  };
}

export interface SetDashboardLayoutOk {
  file: SavedViewsFile;
}

export interface SetDashboardLayoutBadRef {
  error: 'unknown-view-id';
  viewId: string;
}

export type SetDashboardLayoutResult = SetDashboardLayoutOk | SetDashboardLayoutBadRef;

export function setDashboardLayout(
  file: SavedViewsFile,
  slots: DashboardSlot[],
): SetDashboardLayoutResult {
  const knownIds = new Set(file.views.map((v) => v.id));
  for (const slot of slots) {
    if (slot.widget && slot.widget.kind === 'saved-view' && !knownIds.has(slot.widget.viewId)) {
      return { error: 'unknown-view-id', viewId: slot.widget.viewId };
    }
  }
  return {
    file: { ...file, dashboard: { ...file.dashboard, slots } },
  };
}
