/**
 * Content indexer — walks all Syntaur markdown content, reads bodies via the
 * canonical parsers (`src/dashboard/parser.ts`), and emits `SearchDoc[]`.
 *
 * The content dirs are PARAMETERS, never hardcoded `defaultProjectDir()` — the
 * dashboard server and the CLI may use different configured dirs, so hardcoding
 * a default would index a different tree than is displayed (audit finding #8).
 *
 * A module-level cache keyed by `projectsDir|assignmentsDir|includeArchived`
 * makes the expensive body-read happen only on first query and after a content
 * change (detected by a cheap stat-only max-mtime sweep) — never per query.
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileExists } from '../utils/fs.js';
import { listAssignmentsByProject } from '../utils/assignment-walk.js';
import { latestPlanFile } from '../lifecycle/facts.js';
import {
  parseAssignmentFull,
  parsePlan,
  parseProgress,
  parseComments,
  parseHandoff,
  parseDecisionRecord,
  parseScratchpad,
  parseMemory,
  parseResource,
  parseProject,
} from '../dashboard/parser.js';
import type { FileKind, SearchDoc } from './types.js';

export interface IndexOptions {
  projectsDir: string;
  assignmentsDir: string;
  includeArchived?: boolean;
}

/** Identity carried from the owning assignment onto every sidecar doc. */
interface AssignmentIdentity {
  assignmentId: string | null;
  assignmentSlug: string;
  projectSlug: string | null;
  projectWorkspace: string | null;
  standalone: boolean;
  type?: string;
  status?: string;
  archived: boolean;
}

/** The assignment sidecars, each with its kind + parser → body extractor. */
const SIDECARS: Array<{ file: string; kind: FileKind; body: (content: string) => string }> = [
  { file: 'progress.md', kind: 'progress', body: (c) => parseProgress(c).body },
  { file: 'comments.md', kind: 'comments', body: (c) => parseComments(c).body },
  { file: 'handoff.md', kind: 'handoff', body: (c) => parseHandoff(c).body },
  { file: 'decision-record.md', kind: 'decision-record', body: (c) => parseDecisionRecord(c).body },
  { file: 'scratchpad.md', kind: 'scratchpad', body: (c) => parseScratchpad(c).body },
];

/**
 * Build the full content index for the given dirs. Skips archived
 * assignments/projects unless `includeArchived`.
 */
export async function buildIndex(opts: IndexOptions): Promise<SearchDoc[]> {
  const { projectsDir, assignmentsDir, includeArchived = false } = opts;
  const docs: SearchDoc[] = [];

  // ── per-project workspace lookup (read each project.md once) ────────────
  const projectWorkspace = new Map<string, string | null>();
  const projectArchived = new Map<string, boolean>();
  if (await fileExists(projectsDir)) {
    const projects = await readdir(projectsDir, { withFileTypes: true });
    for (const m of projects) {
      if (!m.isDirectory()) continue;
      if (m.name.startsWith('.') || m.name.startsWith('_')) continue;
      const projectMdPath = resolve(projectsDir, m.name, 'project.md');
      let workspace: string | null = null;
      let archived = false;
      if (await fileExists(projectMdPath)) {
        try {
          const parsed = parseProject(await readFile(projectMdPath, 'utf-8'));
          workspace = parsed.workspace;
          archived = parsed.archived;
        } catch {
          // tolerate a malformed project.md — workspace stays null
        }
      }
      projectWorkspace.set(m.name, workspace);
      projectArchived.set(m.name, archived);
    }
  }

  // ── assignments (project-nested + standalone) ───────────────────────────
  const { withAssignmentMd } = await listAssignmentsByProject(projectsDir, assignmentsDir);
  for (const entry of withAssignmentMd) {
    const assignmentMdPath = resolve(entry.assignmentDir, 'assignment.md');
    let assignmentContent: string;
    try {
      assignmentContent = await readFile(assignmentMdPath, 'utf-8');
    } catch {
      continue;
    }
    const assignment = parseAssignmentFull(assignmentContent);

    // An assignment is excluded by default when EITHER it or its owning
    // project is archived. Both flags propagate onto the docs as `archived`.
    const projectIsArchived = entry.projectSlug
      ? projectArchived.get(entry.projectSlug) === true
      : false;
    const archived = assignment.archived || projectIsArchived;

    if (!includeArchived && archived) continue;

    const workspace = entry.projectSlug ? projectWorkspace.get(entry.projectSlug) ?? null : null;
    const identity: AssignmentIdentity = {
      assignmentId: assignment.id || null,
      assignmentSlug: entry.assignmentSlug,
      projectSlug: entry.projectSlug,
      projectWorkspace: workspace,
      standalone: entry.standalone,
      type: assignment.type ?? undefined,
      status: assignment.status,
      archived,
    };

    // assignment.md itself
    docs.push(makeAssignmentDoc(assignmentMdPath, 'assignment', assignment.title, assignment.body, identity));

    // latest plan only
    const planName = await latestPlanFile(entry.assignmentDir);
    if (planName) {
      const planPath = join(entry.assignmentDir, planName);
      if (await fileExists(planPath)) {
        try {
          const plan = parsePlan(await readFile(planPath, 'utf-8'));
          docs.push(makeAssignmentDoc(planPath, 'plan', assignment.title, plan.body, identity));
        } catch {
          /* skip unreadable plan */
        }
      }
    }

    // sidecars
    for (const sidecar of SIDECARS) {
      const sidecarPath = resolve(entry.assignmentDir, sidecar.file);
      if (!(await fileExists(sidecarPath))) continue;
      try {
        const body = sidecar.body(await readFile(sidecarPath, 'utf-8'));
        docs.push(makeAssignmentDoc(sidecarPath, sidecar.kind, assignment.title, body, identity));
      } catch {
        /* skip unreadable sidecar */
      }
    }
  }

  // ── project memories + resources ────────────────────────────────────────
  if (await fileExists(projectsDir)) {
    const projects = await readdir(projectsDir, { withFileTypes: true });
    for (const m of projects) {
      if (!m.isDirectory()) continue;
      if (m.name.startsWith('.') || m.name.startsWith('_')) continue;
      const projectIsArchived = projectArchived.get(m.name) === true;
      if (projectIsArchived && !includeArchived) continue;
      const projectPath = resolve(projectsDir, m.name);
      const workspace = projectWorkspace.get(m.name) ?? null;

      await indexItems(
        docs,
        resolve(projectPath, 'memories'),
        'memory',
        m.name,
        workspace,
        projectIsArchived,
        (content) => {
          const parsed = parseMemory(content);
          return { title: parsed.name, body: parsed.body };
        },
      );
      await indexItems(
        docs,
        resolve(projectPath, 'resources'),
        'resource',
        m.name,
        workspace,
        projectIsArchived,
        (content) => {
          const parsed = parseResource(content);
          return { title: parsed.name, body: parsed.body };
        },
      );
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
    projectWorkspace: identity.projectWorkspace,
    assignmentSlug: identity.assignmentSlug,
    assignmentId: identity.assignmentId,
    standalone: identity.standalone,
    type: identity.type,
    status: identity.status,
    archived: identity.archived,
  };
}

/** Index every `*.md` (skipping `_index.md` / dot-prefixed) in a memories/resources dir. */
async function indexItems(
  docs: SearchDoc[],
  dir: string,
  fileKind: 'memory' | 'resource',
  projectSlug: string,
  projectWorkspace: string | null,
  archived: boolean,
  extract: (content: string) => { title: string; body: string },
): Promise<void> {
  if (!(await fileExists(dir))) return;
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    if (!e.isFile()) continue;
    if (!e.name.endsWith('.md')) continue;
    if (e.name.startsWith('.') || e.name.startsWith('_')) continue;
    const itemSlug = e.name.slice(0, -'.md'.length);
    const filePath = resolve(dir, e.name);
    try {
      const { title, body } = extract(await readFile(filePath, 'utf-8'));
      docs.push({
        id: filePath,
        path: filePath,
        fileKind,
        title,
        body,
        projectSlug,
        projectWorkspace,
        assignmentSlug: null,
        assignmentId: null,
        standalone: false,
        itemSlug,
        archived,
      });
    } catch {
      /* skip unreadable item */
    }
  }
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
  return `${opts.projectsDir}|${opts.assignmentsDir}|${opts.includeArchived ?? false}`;
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
  assignmentsDir: string,
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
  if (assignmentsDir !== projectsDir) await walk(assignmentsDir);
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
  const signature = await indexSignature(opts.projectsDir, opts.assignmentsDir);
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
