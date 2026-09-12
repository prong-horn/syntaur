/**
 * Content indexer — walks all Syntaur markdown content, reads bodies via the
 * canonical parsers (`src/dashboard/parser.ts`), and emits `SearchDoc[]`.
 *
 * The content dirs are PARAMETERS, never hardcoded `defaultProjectDir()` — the
 * dashboard server and the CLI may use different configured dirs, so hardcoding
 * a default would index a different tree than is displayed (audit finding #8).
 *
 * A module-level cache keyed by `projectsDir|ticketsDir|includeArchived`
 * makes the expensive body-read happen only on first query and after a content
 * change (detected by a cheap stat-only max-mtime sweep) — never per query.
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileExists } from '../utils/fs.js';
import { listTicketsByProject } from '../utils/ticket-walk.js';
import { latestPlanFile } from '../lifecycle/facts.js';
import {
  parseTicketFull,
  parsePlan,
  parseProgress,
  parseComments,
  parseHandoff,
  parseDecisionRecord,
  parseScratchpad,
  parseProject,
} from '../dashboard/parser.js';
import type { FileKind, SearchDoc } from './types.js';

export interface IndexOptions {
  projectsDir: string;
  ticketsDir?: string;
  includeArchived?: boolean;
}

function resolveStandaloneTicketsDir(opts: IndexOptions): string {
  return opts.ticketsDir ?? opts.projectsDir;
}

/** Identity carried from the owning ticket onto every sidecar doc. */
interface AssignmentIdentity {
  ticketId: string | null;
  ticketSlug: string;
  projectSlug: string | null;
  standalone: boolean;
  type?: string;
  status?: string;
  archived: boolean;
}

/** The ticket sidecars, each with its kind + parser → body extractor. */
const SIDECARS: Array<{ file: string; kind: FileKind; body: (content: string) => string }> = [
  { file: 'progress.md', kind: 'progress', body: (c) => parseProgress(c).body },
  { file: 'comments.md', kind: 'comments', body: (c) => parseComments(c).body },
  { file: 'handoff.md', kind: 'handoff', body: (c) => parseHandoff(c).body },
  { file: 'decision-record.md', kind: 'decision-record', body: (c) => parseDecisionRecord(c).body },
  { file: 'scratchpad.md', kind: 'scratchpad', body: (c) => parseScratchpad(c).body },
];

/**
 * Build the full content index for the given dirs. Skips archived
 * tickets/projects unless `includeArchived`.
 */
export async function buildIndex(opts: IndexOptions): Promise<SearchDoc[]> {
  const { projectsDir, includeArchived = false } = opts;
  const ticketsDir = resolveStandaloneTicketsDir(opts);
  const docs: SearchDoc[] = [];

  const projectArchived = new Map<string, boolean>();
  if (await fileExists(projectsDir)) {
    const projects = await readdir(projectsDir, { withFileTypes: true });
    for (const m of projects) {
      if (!m.isDirectory()) continue;
      if (m.name.startsWith('.') || m.name.startsWith('_')) continue;
      const projectMdPath = resolve(projectsDir, m.name, 'project.md');
      let archived = false;
      if (await fileExists(projectMdPath)) {
        try {
          const parsed = parseProject(await readFile(projectMdPath, 'utf-8'));
          archived = parsed.archived;
        } catch {
          // tolerate a malformed project.md — archived stays false
        }
      }
      projectArchived.set(m.name, archived);
    }
  }

  // ── assignments (project-nested + standalone) ───────────────────────────
  const { withAssignmentMd } = await listTicketsByProject(projectsDir, ticketsDir);
  for (const entry of withAssignmentMd) {
    const assignmentMdPath = resolve(entry.ticketDir, 'ticket.md');
    let assignmentContent: string;
    try {
      assignmentContent = await readFile(assignmentMdPath, 'utf-8');
    } catch {
      continue;
    }
    const ticket = parseTicketFull(assignmentContent);

    // A ticket is excluded by default when EITHER it or its owning
    // project is archived. Both flags propagate onto the docs as `archived`.
    const projectIsArchived = entry.projectSlug
      ? projectArchived.get(entry.projectSlug) === true
      : false;
    const archived = ticket.archived || projectIsArchived;

    if (!includeArchived && archived) continue;

    const identity: AssignmentIdentity = {
      ticketId: ticket.id || null,
      ticketSlug: entry.ticketSlug,
      projectSlug: entry.projectSlug,
      standalone: entry.standalone,
      type: ticket.type ?? undefined,
      status: ticket.status,
      archived,
    };

    // ticket.md itself
    docs.push(makeAssignmentDoc(assignmentMdPath, 'ticket', ticket.title, ticket.body, identity));

    // latest plan only
    const planName = await latestPlanFile(entry.ticketDir);
    if (planName) {
      const planPath = join(entry.ticketDir, planName);
      if (await fileExists(planPath)) {
        try {
          const plan = parsePlan(await readFile(planPath, 'utf-8'));
          docs.push(makeAssignmentDoc(planPath, 'plan', ticket.title, plan.body, identity));
        } catch {
          /* skip unreadable plan */
        }
      }
    }

    // sidecars
    for (const sidecar of SIDECARS) {
      const sidecarPath = resolve(entry.ticketDir, sidecar.file);
      if (!(await fileExists(sidecarPath))) continue;
      try {
        const body = sidecar.body(await readFile(sidecarPath, 'utf-8'));
        docs.push(makeAssignmentDoc(sidecarPath, sidecar.kind, ticket.title, body, identity));
      } catch {
        /* skip unreadable sidecar */
      }
    }
  }

  return docs;
}

function makeAssignmentDoc(
  path: string,
  fileKind: FileKind,
  title: string,
  body: string,
  identity: AssignmentIdentity,
): SearchDoc {
  return {
    id: path,
    path,
    fileKind,
    title,
    body,
    projectSlug: identity.projectSlug,
    ticketSlug: identity.ticketSlug,
    ticketId: identity.ticketId,
    standalone: identity.standalone,
    type: identity.type,
    status: identity.status,
    archived: identity.archived,
  };
}

// ── cache + invalidation seam ─────────────────────────────────────────────

/**
 * A stat-only fingerprint of the indexed `.md` files. `mtimeMax` alone misses
 * the deletion of a non-newest file (signature unchanged → stale cache), so we
 * also track `count` and `sizeSum` — both of which change on any add OR delete.
 */
interface IndexSignature {
  count: number;
  mtimeMax: number;
  sizeSum: number;
}

interface CacheEntry {
  docs: SearchDoc[];
  builtAt: number;
  signature: IndexSignature;
}

const cache = new Map<string, CacheEntry>();

function cacheKey(opts: IndexOptions): string {
  return `${opts.projectsDir}|${resolveStandaloneTicketsDir(opts)}|${opts.includeArchived ?? false}`;
}

function signaturesEqual(a: IndexSignature, b: IndexSignature): boolean {
  return a.count === b.count && a.mtimeMax === b.mtimeMax && a.sizeSum === b.sizeSum;
}

/**
 * Cheap stat-only sweep of the content dirs → an {@link IndexSignature}. Walks
 * dirs (O(files) `stat`s, NOT reads). `count` + `sizeSum` change on add/delete;
 * `mtimeMax` changes on modification. Returns all-zeros when nothing exists.
 */
async function indexSignature(
  projectsDir: string,
  ticketsDir: string,
): Promise<IndexSignature> {
  let count = 0;
  let mtimeMax = 0;
  let sizeSum = 0;
  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const full = resolve(dir, e.name);
      if (e.isDirectory()) {
        await walk(full);
      } else if (e.isFile() && e.name.endsWith('.md')) {
        try {
          const s = await stat(full);
          count += 1;
          sizeSum += s.size;
          if (s.mtimeMs > mtimeMax) mtimeMax = s.mtimeMs;
        } catch {
          /* ignore */
        }
      }
    }
  }
  await walk(projectsDir);
  if (ticketsDir !== projectsDir) await walk(ticketsDir);
  return { count, mtimeMax, sizeSum };
}

/**
 * Return the index for the given dirs, rebuilding only when content changed.
 *
 * Semantics: compute the current {@link IndexSignature} via a stat-only sweep;
 * if a cache entry for this key exists AND its signature is unchanged, return
 * the cached docs (no body reads); otherwise do a full `buildIndex`, replace
 * the cache entry, and return it. The signature changes on add, delete, and
 * modification of any indexed `.md` file.
 */
export async function getIndex(opts: IndexOptions): Promise<SearchDoc[]> {
  const key = cacheKey(opts);
  const ticketsDir = resolveStandaloneTicketsDir(opts);
  const signature = await indexSignature(opts.projectsDir, ticketsDir);
  const existing = cache.get(key);
  if (existing && signaturesEqual(existing.signature, signature)) {
    return existing.docs;
  }
  const docs = await buildIndex(opts);
  cache.set(key, { docs, builtAt: Date.now(), signature });
  return docs;
}

/** Clear the whole cache so the next `getIndex` rebuilds (file-change hook). */
export function invalidateIndex(): void {
  cache.clear();
}
