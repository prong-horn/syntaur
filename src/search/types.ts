/**
 * Shared search types — the contract between the indexer, the `SearchProvider`
 * implementations (Fuse default, Semantic stub seam), and both consumers (the
 * `syntaur search` CLI and the dashboard content-search router/palette).
 *
 * The provider returns a NEUTRAL snippet (no highlight markers) plus
 * `matches: MatchRange[]` (snippet-local char offsets) so each caller formats
 * highlighting itself: the CLI wraps with `**…**`, the API/palette wrap with
 * HTML-safe `<mark>`.
 *
 * Aligns with `EntityKind`/scope semantics in `src/utils/search-schema.ts`
 * (that module covers entity-record search; this one covers markdown bodies).
 */

/** The markdown content kinds indexed for full-text body search. */
export type FileKind =
  | 'assignment'
  | 'plan'
  | 'progress'
  | 'comments'
  | 'handoff'
  | 'decision-record'
  | 'scratchpad'
  | 'memory'
  | 'resource';

export const FILE_KINDS: readonly FileKind[] = [
  'assignment',
  'plan',
  'progress',
  'comments',
  'handoff',
  'decision-record',
  'scratchpad',
  'memory',
  'resource',
];

/**
 * One indexed markdown document. Carries the body to search plus the
 * filter+route identity propagated from the owning assignment / project
 * frontmatter so the provider can pre-filter (`type`/`status`/`project`/`in`)
 * and the route builder can produce a deep-link without re-reading anything.
 */
export interface SearchDoc {
  /** Stable id — the absolute file path doubles as the id. */
  id: string;
  /** Absolute file path on disk. */
  path: string;
  fileKind: FileKind;
  /** Human title (assignment/project/memory/resource title), used as a Fuse key. */
  title: string;
  /** The markdown body to full-text search. */
  body: string;
  /** Nearest-heading section, when the indexer can cheaply attribute one. */
  section?: string;

  // ── filter + route identity (carried from frontmatter) ──────────────────
  /** Owning project slug; `null` for standalone assignments. */
  projectSlug: string | null;
  /**
   * The owning project's `workspace` field (from project.md) — drives the
   * `/w/<ws>` route prefix the palette applies. `null` for standalone.
   */
  projectWorkspace: string | null;
  /** Owning assignment slug; `null` for memory/resource docs. */
  assignmentSlug: string | null;
  /** Owning assignment id (uuid); `null` for memory/resource docs. */
  assignmentId: string | null;
  /** True when the owning assignment is standalone (no containing project). */
  standalone: boolean;
  /** Memory/resource file slug (filename without `.md`); absent otherwise. */
  itemSlug?: string;
  /** Owning assignment `type` (for `--type` filtering); absent for memory/resource. */
  type?: string;
  /** Owning assignment `status` (for `--status` filtering); absent for memory/resource. */
  status?: string;
  /** Archived flag (from assignment or project frontmatter). */
  archived: boolean;
}

/** A match range in NEUTRAL char offsets into `SearchHit.snippet`. */
export interface MatchRange {
  start: number;
  end: number;
}

/**
 * One ranked search result. `snippet` is NEUTRAL text (no markers); callers
 * apply `matches` to highlight. `route` is the precomputed UNPREFIXED deep-link
 * (the palette prepends the per-hit `/w/<workspace>` prefix).
 */
export interface SearchHit {
  path: string;
  projectSlug: string | null;
  projectWorkspace: string | null;
  assignmentSlug: string | null;
  assignmentId: string | null;
  standalone: boolean;
  itemSlug?: string;
  fileKind: FileKind;
  title: string;
  score: number;
  snippet: string;
  matches: MatchRange[];
  /** 1-based line number of the match in the source body. */
  line: number;
  section?: string;
  /** Precomputed unprefixed app route (see `routeForHit`). */
  route: string;
}

/** A search request. `in` is the canonical-resolved file-kind filter. */
export interface SearchQuery {
  query: string;
  project?: string;
  type?: string[];
  status?: string[];
  in?: FileKind[];
}

/**
 * The provider seam. `index` ingests the docs; `query` runs a ranked search.
 * `FuseProvider` is the default; `SemanticProvider` is a stub for the future
 * embeddings slot.
 */
export interface SearchProvider {
  index(docs: SearchDoc[]): void | Promise<void>;
  query(q: SearchQuery, limit: number): SearchHit[] | Promise<SearchHit[]>;
}

/**
 * `--in` alias map — both singular and plural/common forms resolve to the
 * canonical `FileKind`. Resolves the `--in comments,plans` mismatch (`plans` →
 * `plan`).
 */
export const FILE_KIND_ALIASES: Record<string, FileKind> = {
  assignment: 'assignment',
  assignments: 'assignment',
  plan: 'plan',
  plans: 'plan',
  progress: 'progress',
  comment: 'comments',
  comments: 'comments',
  handoff: 'handoff',
  handoffs: 'handoff',
  decision: 'decision-record',
  decisions: 'decision-record',
  'decision-record': 'decision-record',
  'decision-records': 'decision-record',
  scratchpad: 'scratchpad',
  scratchpads: 'scratchpad',
  memory: 'memory',
  memories: 'memory',
  resource: 'resource',
  resources: 'resource',
};

/**
 * Parse a comma-separated `--in` list into canonical `FileKind[]`. Splits,
 * trims, lowercases, and resolves via {@link FILE_KIND_ALIASES}. Throws on an
 * unknown kind with a message listing the valid kinds. Empty/blank entries are
 * dropped; a fully-empty input returns `[]`.
 */
export function parseFileKinds(csv: string): FileKind[] {
  const out: FileKind[] = [];
  for (const raw of csv.split(',')) {
    const token = raw.trim().toLowerCase();
    if (token.length === 0) continue;
    const canonical = FILE_KIND_ALIASES[token];
    if (!canonical) {
      const valid = Array.from(new Set(Object.keys(FILE_KIND_ALIASES))).join(', ');
      throw new Error(`Unknown file kind "${token}". Valid kinds: ${valid}`);
    }
    if (!out.includes(canonical)) out.push(canonical);
  }
  return out;
}
