import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileExists } from '../utils/fs.js';
import { parseProject, parseTicketFull } from './parser.js';

export interface RepositoryCandidate {
  path: string;
  source: 'project' | 'sibling';
  /** Slug of the sibling ticket that provided this repo. Null for `project`-sourced. */
  sourceTicketSlug: string | null;
}

/**
 * A candidate ticket to "branch off" — one that already has a resolved
 * workspace (both `workspace.repository` and `workspace.branch` set). Branching
 * off it reuses its repository and uses its branch as the new worktree's parent.
 */
export interface SourceTicket {
  /** Stable unique identifier (the ticket UUID). */
  id: string;
  slug: string;
  title: string;
  repository: string;
  branch: string;
}

/**
 * Build a {@link SourceTicket} from a parsed ticket, or `null` when it
 * lacks a usable workspace (missing/blank repository or branch).
 */
function toSourceTicket(
  parsed: ReturnType<typeof parseTicketFull>,
  fallbackId: string,
): SourceTicket | null {
  const repository = parsed.workspace.repository?.trim();
  const branch = parsed.workspace.branch?.trim();
  if (!repository || !branch) return null;
  const slug = parsed.slug?.trim() || fallbackId;
  return {
    id: parsed.id?.trim() || fallbackId,
    slug,
    title: parsed.title?.trim() || slug,
    repository,
    branch,
  };
}

/**
 * Collect repository candidates for a project-nested ticket.
 *
 * Order: project-configured first (in declaration order), then
 * sibling-harvested from other tickets in the same project. Deduped by
 * absolute path; the first occurrence wins. Missing project.md or tickets
 * directory returns `[]`.
 */
export async function getProjectRepositoryCandidates(
  projectsDir: string,
  projectSlug: string,
): Promise<RepositoryCandidate[]> {
  const seen = new Set<string>();
  const out: RepositoryCandidate[] = [];

  const projectPath = resolve(projectsDir, projectSlug, 'project.md');
  if (await fileExists(projectPath)) {
    const project = parseProject(await readFile(projectPath, 'utf-8'));
    for (const raw of project.repositories) {
      const path = raw.trim();
      if (!path) continue;
      const abs = resolve(path);
      if (seen.has(abs)) continue;
      seen.add(abs);
      out.push({ path: abs, source: 'project', sourceTicketSlug: null });
    }
  }

  const ticketsDir = resolve(projectsDir, projectSlug, 'tickets');
  if (await fileExists(ticketsDir)) {
    const entries = await readdir(ticketsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const ticketMd = resolve(ticketsDir, entry.name, 'ticket.md');
      if (!(await fileExists(ticketMd))) continue;
      const parsed = parseTicketFull(await readFile(ticketMd, 'utf-8'));
      const repo = parsed.workspace.repository?.trim();
      if (!repo) continue;
      const abs = resolve(repo);
      if (seen.has(abs)) continue;
      seen.add(abs);
      out.push({ path: abs, source: 'sibling', sourceTicketSlug: parsed.slug });
    }
  }

  return out;
}

/**
 * Collect repository candidates for a standalone ticket by harvesting
 * `workspace.repository` from sibling standalone tickets. Excludes the
 * ticket id passed in (typically the one the user is configuring).
 */
export async function getStandaloneRepositoryCandidates(
  ticketsDir: string,
  excludeTicketId: string,
): Promise<RepositoryCandidate[]> {
  if (!(await fileExists(ticketsDir))) {
    return [];
  }

  const seen = new Set<string>();
  const out: RepositoryCandidate[] = [];

  const entries = await readdir(ticketsDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name === excludeTicketId) continue;
    const ticketMd = resolve(ticketsDir, entry.name, 'ticket.md');
    if (!(await fileExists(ticketMd))) continue;
    const parsed = parseTicketFull(await readFile(ticketMd, 'utf-8'));
    const repo = parsed.workspace.repository?.trim();
    if (!repo) continue;
    const abs = resolve(repo);
    if (seen.has(abs)) continue;
    seen.add(abs);
    out.push({ path: abs, source: 'sibling', sourceTicketSlug: parsed.slug });
  }

  return out;
}

/**
 * List sibling tickets in a project that can be branched off (both
 * `workspace.repository` and `workspace.branch` are set). Excludes the
 * ticket being configured and dedupes by slug (the project dir name, which
 * is unique within a project). Missing tickets directory returns `[]`.
 */
export async function getProjectSourceTickets(
  projectsDir: string,
  projectSlug: string,
  excludeSlug: string,
): Promise<SourceTicket[]> {
  const ticketsDir = resolve(projectsDir, projectSlug, 'tickets');
  if (!(await fileExists(ticketsDir))) return [];

  const seen = new Set<string>();
  const out: SourceTicket[] = [];

  const entries = await readdir(ticketsDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name === excludeSlug) continue;
    const ticketMd = resolve(ticketsDir, entry.name, 'ticket.md');
    if (!(await fileExists(ticketMd))) continue;
    const parsed = parseTicketFull(await readFile(ticketMd, 'utf-8'));
    const source = toSourceTicket(parsed, entry.name);
    if (!source) continue;
    // Exclude + dedupe by the directory name (route-authoritative, unique within
    // the project) rather than parsed frontmatter, which could be malformed.
    if (seen.has(entry.name)) continue;
    seen.add(entry.name);
    out.push(source);
  }

  return out;
}

/**
 * List standalone tickets that can be branched off (both
 * `workspace.repository` and `workspace.branch` are set). Excludes the
 * ticket being configured and dedupes by the UUID `id` (standalone slugs
 * are display-only and may collide). Missing directory returns `[]`.
 */
export async function getStandaloneSourceTickets(
  ticketsDir: string,
  excludeTicketId: string,
): Promise<SourceTicket[]> {
  if (!(await fileExists(ticketsDir))) return [];

  const seen = new Set<string>();
  const out: SourceTicket[] = [];

  const entries = await readdir(ticketsDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name === excludeTicketId) continue;
    const ticketMd = resolve(ticketsDir, entry.name, 'ticket.md');
    if (!(await fileExists(ticketMd))) continue;
    const parsed = parseTicketFull(await readFile(ticketMd, 'utf-8'));
    const source = toSourceTicket(parsed, entry.name);
    if (!source) continue;
    // Exclude + dedupe by the directory name (the authoritative UUID) rather
    // than parsed frontmatter.
    if (seen.has(entry.name)) continue;
    seen.add(entry.name);
    out.push(source);
  }

  return out;
}
