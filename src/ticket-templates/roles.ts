import { readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileExists } from '../utils/fs.js';
import type { TemplateManifest } from './manifest.js';
import { planRoleFile } from './manifest.js';
import type { TicketFrontmatter } from '../lifecycle/types.js';
import { loadTemplate, resolveTemplateForTicket } from './registry.js';
import { syntaurRoot } from '../utils/paths.js';

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
 * Resolve an existing plan file for reads/indexing. Tolerates unknown template ids
 * by falling back to `plan.file` then the latest `plan` stem revision.
 */
export async function resolvePlanReadPath(
  ticketDir: string,
  fm: Pick<TicketFrontmatter, 'plan' | 'template'>,
  root = syntaurRoot(),
): Promise<string | null> {
  if (fm.plan.file) {
    const explicit = resolve(ticketDir, fm.plan.file);
    if (await fileExists(explicit)) return fm.plan.file;
  }
  try {
    const manifest = await loadTemplate(root, resolveTemplateForTicket(fm));
    const fromRole = await resolvePlanFileOnDisk(ticketDir, fm, manifest);
    if (fromRole) return fromRole;
  } catch {
    /* custom/unknown template id */
  }
  return await latestPlanRevision(ticketDir, DEFAULT_PLAN_STEM);
}
