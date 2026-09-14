import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileExists } from '../utils/fs.js';
import type { TemplateFile, TemplateManifest } from './manifest.js';
import { planRoleFile } from './manifest.js';
import type { TicketFrontmatter } from '../lifecycle/types.js';
import { isPlanApproved, planDigest } from '../lifecycle/facts.js';
import { loadTemplate, resolveTemplateForTicket } from './registry.js';
import { syntaurRoot } from '../utils/paths.js';
import { nonEmptyBeyondScaffold } from './content.js';
import { parseLogEntries } from './log-reader.js';

export interface PlanRevisionEntry {
  fileName: string;
  version: number;
}

/** Build a revision pattern for `<stem>.md` and `<stem>-v<N>.md`. */
export function planRevisionPattern(stem: string): RegExp {
  const escaped = stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped}(?:-v(\\d+))?\\.md$`);
}

/** Stem from a plan-role path (`plan.md` → `plan`). */
export function planStemFromPath(path: string): string {
  return path.replace(/\.md$/i, '');
}

export async function planRevisions(
  ticketDir: string,
  stem: string,
): Promise<PlanRevisionEntry[]> {
  if (!(await fileExists(ticketDir))) return [];
  const pattern = planRevisionPattern(stem);
  const entries = await readdir(ticketDir, { withFileTypes: true });
  const out: PlanRevisionEntry[] = [];
  for (const e of entries) {
    if (!e.isFile()) continue;
    const m = e.name.match(pattern);
    if (!m) continue;
    const version = m[1] ? parseInt(m[1], 10) : 1;
    out.push({ fileName: e.name, version });
  }
  out.sort((a, b) => a.version - b.version);
  return out;
}

/** Latest plan revision for a stem (`plan.md` = v1 < `plan-v2.md` < …). */
export async function latestPlanRevision(
  ticketDir: string,
  stem: string,
): Promise<string | null> {
  const files = await planRevisions(ticketDir, stem);
  return files.length > 0 ? files[files.length - 1].fileName : null;
}

export function nextPlanRevisionName(stem: string, currentVersion: number): string {
  const next = currentVersion + 1;
  return next === 1 ? `${stem}.md` : `${stem}-v${next}.md`;
}

/**
 * Resolve the plan file path for reads/edits: `plan.file` when set, else the
 * declared plan-role path. No latest-revision fallback.
 */
export function planFileFor(
  fm: Pick<TicketFrontmatter, 'plan'>,
  manifest: TemplateManifest,
): string | null {
  if (fm.plan.file) return fm.plan.file;
  const role = planRoleFile(manifest);
  return role?.path ?? null;
}

/** Default plan stem when no manifest is available (legacy tickets). */
export const DEFAULT_PLAN_STEM = 'plan';

/**
 * Resolve the plan file to read for a ticket: `planFileFor` when that path exists
 * on disk, else null (no latest-revision fallback).
 */
export async function resolvePlanFileOnDisk(
  ticketDir: string,
  fm: Pick<TicketFrontmatter, 'plan' | 'template'>,
  manifest: TemplateManifest,
): Promise<string | null> {
  const planPath = planFileFor(fm, manifest);
  if (!planPath) return null;
  if (!(await fileExists(resolve(ticketDir, planPath)))) return null;
  return planPath;
}

/**
 * Resolve an existing plan file for reads/indexing via `planFileFor` when that
 * path exists. Unknown templates fall back to `plan.file` only (no revision scan).
 */
export async function resolvePlanReadPath(
  ticketDir: string,
  fm: Pick<TicketFrontmatter, 'plan' | 'template'>,
  root = syntaurRoot(),
): Promise<string | null> {
  try {
    const manifest = await loadTemplate(root, resolveTemplateForTicket(fm));
    return await resolvePlanFileOnDisk(ticketDir, fm, manifest);
  } catch {
    if (!fm.plan.file) return null;
    const explicit = resolve(ticketDir, fm.plan.file);
    if (await fileExists(explicit)) return fm.plan.file;
    return null;
  }
}

function formatLogAge(timestamp: string, now = Date.now()): string {
  const then = Date.parse(timestamp);
  if (Number.isNaN(then)) return 'unknown';
  const minutes = Math.max(0, Math.floor((now - then) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

/** Rendered file-state string for the Files block (§7.1). */
export async function fileState(
  entry: TemplateFile,
  ticketDir: string,
  fm: Pick<TicketFrontmatter, 'plan' | 'template'>,
  manifest: TemplateManifest,
  now = Date.now(),
): Promise<string> {
  const path = resolve(ticketDir, entry.path);
  const exists = await fileExists(path);

  if (entry.role === 'plan') {
    const planPath = planFileFor(fm, manifest);
    if (!planPath) return 'missing';
    const planFull = resolve(ticketDir, planPath);
    if (!(await fileExists(planFull))) return 'missing';
    const content = await readFile(planFull, 'utf-8');
    if (!nonEmptyBeyondScaffold(content)) return 'unapproved';
    if (!fm.plan.approvedDigest) return 'unapproved';
    if (await isPlanApproved(ticketDir, fm)) return 'approved';
    const digest = planDigest(content);
    if (fm.plan.approvedDigest === digest) return 'approved';
    return 'stale';
  }

  if (entry.role === 'log') {
    if (!exists) return '0 entries';
    const entries = parseLogEntries(await readFile(path, 'utf-8'));
    if (entries.length === 0) return '0 entries';
    const latest = entries[0];
    return `${entries.length} entries · last ${latest.type} ${formatLogAge(latest.timestamp, now)}`;
  }

  if (entry.role === 'deliverable') {
    if (!exists) return 'empty';
    const content = await readFile(path, 'utf-8');
    return nonEmptyBeyondScaffold(content) ? 'present' : 'empty';
  }

  if (!exists) return 'missing';
  return 'editable';
}
