/**
 * Content indexer — walks all Syntaur markdown content, reads bodies via the
 * canonical parsers (`src/dashboard/parser.ts`), and emits `SearchDoc[]`.
 *
 * The content dirs are PARAMETERS, never hardcoded `defaultProjectDir()` — the
 * dashboard server and the CLI may use different configured dirs, so hardcoding
 * a default would index a different tree than is displayed (audit finding #8).
 *
 * A module-level cache keyed by `projectsDirincludeArchived`
 * makes the expensive body-read happen only on first query and after a content
 * change (detected by a cheap stat-only max-mtime sweep) — never per query.
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileExists } from '../utils/fs.js';
import { syntaurRoot } from '../utils/paths.js';
import { listTicketsByProject } from '../utils/ticket-walk.js';
import { resolvePlanReadPath } from '../ticket-templates/roles.js';
import { loadTemplate, resolveTemplateForTicket } from '../ticket-templates/registry.js';
import { logRoleFile } from '../ticket-templates/manifest.js';
import { parseLogEntries } from '../ticket-templates/log-reader.js';
import {
  parseTicketFull,
  parsePlan,
  parseComments,
  parseHandoff,
  parseDecisionRecord,
  parseScratchpad,
  parseProject,
} from '../dashboard/parser.js';
import type { FileKind, SearchDoc } from './types.js';

export interface IndexOptions {
  projectsDir: string;
  /** @deprecated Standalone tickets were removed; ignored when set. */
  includeArchived?: boolean;
}

/** Identity carried from the owning ticket onto every sidecar doc. */
interface TicketIdentity {
  ticketId: string | null;
  ticketSlug: string;
  projectSlug: string | null;
  /** @deprecated Standalone tickets were removed; always false. */
  standalone: false;
  template?: string;
  status?: string;
  archived: boolean;
}

/** Legacy ticket sidecars (un-merged tickets). Log-role files are indexed separately. */
const LEGACY_SIDECARS: Array<{ file: string; kind: FileKind; body: (content: string) => string }> = [
  { file: 'progress.md', kind: 'progress', body: (c) => parseProgressLegacyBody(c) },
  { file: 'comments.md', kind: 'comments', body: (c) => parseComments(c).body },
  { file: 'handoff.md', kind: 'handoff', body: (c) => parseHandoff(c).body },
  { file: 'decision-record.md', kind: 'decision-record', body: (c) => parseDecisionRecord(c).body },
  { file: 'scratchpad.md', kind: 'scratchpad', body: (c) => parseScratchpad(c).body },
];

function parseProgressLegacyBody(content: string): string {
  return parseLogEntries(content)
    .map((e) => [e.firstLine, e.body].filter(Boolean).join('\n'))
    .join('\n\n');
}

function journalSearchBody(content: string): string {
  return parseLogEntries(content)
    .map((e) => [e.firstLine, e.body].filter(Boolean).join('\n'))
    .join('\n\n');
}

/**
 * Build the full content index for the given dirs. Skips archived
 * tickets/projects unless `includeArchived`.
 */
export async function buildIndex(opts: IndexOptions): Promise<SearchDoc[]> {
  const { projectsDir, includeArchived = false } = opts;
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

  // ── project-nested tickets under tickets/<ID>-<slug>/ ───────────────
  const { withTicketMd } = await listTicketsByProject(projectsDir);
  for (const entry of withTicketMd) {
    const ticketMdPath = resolve(entry.ticketDir, 'ticket.md');
    let ticketContent: string;
    try {
      ticketContent = await readFile(ticketMdPath, 'utf-8');
    } catch {
      continue;
    }
    const ticket = parseTicketFull(ticketContent);

    // A ticket is excluded by default when EITHER it or its owning
    // project is archived. Both flags propagate onto the docs as `archived`.
    const projectIsArchived = entry.projectSlug
      ? projectArchived.get(entry.projectSlug) === true
      : false;
    const archived = projectIsArchived;

    if (!includeArchived && archived) continue;

    const ticketId = ticket.id || entry.ticketId;
    const identity: TicketIdentity = {
      ticketId: ticketId || null,
      ticketSlug: entry.ticketSlug,
      projectSlug: entry.projectSlug,
      standalone: false,
      template: ticket.template ?? undefined,
      status: ticket.status,
      archived,
    };

    // ticket.md itself
    docs.push(makeTicketDoc(ticketMdPath, 'ticket', ticket.title, ticket.body, identity));

    const planName = await resolvePlanReadPath(entry.ticketDir, ticket);
    if (planName) {
      const planPath = join(entry.ticketDir, planName);
      if (await fileExists(planPath)) {
        try {
          const plan = parsePlan(await readFile(planPath, 'utf-8'));
          docs.push(makeTicketDoc(planPath, 'plan', ticket.title, plan.body, identity));
        } catch {
          /* skip unreadable plan */
        }
      }
    }

    // log-role file (journal.md on feature/merged tickets)
    let logRolePath: string | null = null;
    try {
      const manifest = await loadTemplate(syntaurRoot(), resolveTemplateForTicket(ticket));
      const logRole = logRoleFile(manifest);
      if (logRole) {
        logRolePath = logRole.path;
        const logPath = resolve(entry.ticketDir, logRole.path);
        if (await fileExists(logPath)) {
          const content = await readFile(logPath, 'utf-8');
          const kind: FileKind = logRole.path === 'journal.md' ? 'journal' : 'progress';
          const body =
            kind === 'journal' ? journalSearchBody(content) : parseProgressLegacyBody(content);
          docs.push(makeTicketDoc(logPath, kind, ticket.title, body, identity));
        }
      }
    } catch {
      /* skip unreadable log role */
    }

    // legacy sidecars (skip progress.md when already indexed as the log role)
    for (const sidecar of LEGACY_SIDECARS) {
      if (sidecar.file === logRolePath) continue;
      const sidecarPath = resolve(entry.ticketDir, sidecar.file);
      if (!(await fileExists(sidecarPath))) continue;
      try {
        const body = sidecar.body(await readFile(sidecarPath, 'utf-8'));
        docs.push(makeTicketDoc(sidecarPath, sidecar.kind, ticket.title, body, identity));
      } catch {
        /* skip unreadable sidecar */
      }
    }
  }

  return docs;
}

function makeTicketDoc(
  path: string,
  fileKind: FileKind,
  title: string,
  body: string,
  identity: TicketIdentity,
): SearchDoc {
  const stableId = identity.ticketId
    ? `${identity.ticketId}:${fileKind}:${path}`
    : path;
  return {
    id: stableId,
    path,
    fileKind,
    title,
    body,
    projectSlug: identity.projectSlug,
    ticketSlug: identity.ticketSlug,
    ticketId: identity.ticketId,
    standalone: identity.standalone,
    template: identity.template,
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
  return `${opts.projectsDir}|${opts.includeArchived ?? false}`;
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
  const signature = await indexSignature(opts.projectsDir);
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
