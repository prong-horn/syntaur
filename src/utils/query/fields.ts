/**
 * AQL field registry — the curated vocabulary queries may reference.
 *
 * Seam (derived-status design v3, Piece 1): users define *conditions*
 * (queries); Syntaur defines the *fact/field set*. A new condition is a config
 * edit; a new field is a Syntaur release here.
 *
 * Browser-safe: accessors read from a plain `QueryItem` record that callers
 * (CLI loader / dashboard payload) have already materialized — never from the
 * filesystem.
 */

/** The flat record a query evaluates against. */
export type QueryItem = Record<string, unknown>;

export type FieldKind =
  | 'enum' // case-insensitive equality (status, phase, type, …)
  | 'string' // equality, with `none` sentinel for null (assignee, project)
  | 'substring' // case-insensitive containment (title/search)
  | 'bool'
  | 'number'
  | 'ordinal' // ordered enum — supports < > (priority)
  | 'timestamp' // ISO string; comparisons vs dates and duration literals
  | 'duration' // milliseconds; comparisons vs duration-literal magnitude
  | 'list'; // membership (tags)

export interface FieldDef {
  kind: FieldKind;
  /** Read the raw value from an item. Default: direct key access by canonical name. */
  get?: (item: QueryItem) => unknown;
  /** Ordinal ordering, low → high (required for kind 'ordinal'). */
  order?: string[];
  /** Accept `field:none` as a null/empty check. */
  noneSentinel?: boolean;
}

export type FieldRegistry = Record<string, FieldDef>;

export const PRIORITY_ORDER = ['low', 'medium', 'high', 'critical'];

/**
 * Default assignment field vocabulary: core frontmatter fields (AQL design,
 * Piece 2 table) + the derived-status fact fields (derived-status design v3,
 * Piece 1). Consumers may extend or restrict (e.g. derive rules evaluate over
 * facts only).
 */
export const ASSIGNMENT_FIELDS: FieldRegistry = {
  // ── core fields ──────────────────────────────────────────────────────────
  status: { kind: 'enum' },
  priority: { kind: 'ordinal', order: PRIORITY_ORDER },
  type: { kind: 'enum' },
  assignee: { kind: 'string', noneSentinel: true },
  project: { kind: 'string', noneSentinel: true },
  tag: { kind: 'list', get: (i) => i['tags'] },
  tags: { kind: 'list' },
  archived: { kind: 'bool' },
  title: { kind: 'substring' },
  search: { kind: 'substring', get: (i) => i['title'] },
  created: { kind: 'timestamp' },
  updated: { kind: 'timestamp' },
  completedat: { kind: 'timestamp', get: (i) => i['completedAt'] },
  statusage: { kind: 'duration', get: (i) => i['statusAge'] },

  // ── derived-status dimensions ────────────────────────────────────────────
  phase: { kind: 'enum' },
  disposition: { kind: 'enum' },
  phaseage: { kind: 'duration', get: (i) => i['phaseAge'] },

  // ── objective facts ──────────────────────────────────────────────────────
  hasrealobjective: { kind: 'bool', get: (i) => i['hasRealObjective'] },
  acrealtotal: { kind: 'number', get: (i) => i['acRealTotal'] },
  acrealchecked: { kind: 'number', get: (i) => i['acRealChecked'] },
  acallchecked: { kind: 'bool', get: (i) => i['acAllChecked'] },
  planexists: { kind: 'bool', get: (i) => i['planExists'] },
  planapproved: { kind: 'bool', get: (i) => i['planApproved'] },
  workspaceset: { kind: 'bool', get: (i) => i['workspaceSet'] },
  implementationstarted: { kind: 'bool', get: (i) => i['implementationStarted'] },
  depssatisfied: { kind: 'bool', get: (i) => i['depsSatisfied'] },
  unresolvedquestions: { kind: 'number', get: (i) => i['unresolvedQuestions'] },
  progressstaledays: { kind: 'duration', get: (i) => i['progressStaleDays'] },

  // ── asserted facts ───────────────────────────────────────────────────────
  blocked: { kind: 'bool' },
  parked: { kind: 'bool' },
  reviewrequested: { kind: 'bool', get: (i) => i['reviewRequested'] },
  pinned: { kind: 'bool' },
};

/**
 * Field lookup is case-insensitive: registry keys are lowercase; `resolveField`
 * lowercases the query's field name. Accessors fall back to the item's
 * camelCase canonical key via `get`.
 */
export function resolveField(registry: FieldRegistry, name: string): FieldDef | null {
  return registry[name.toLowerCase()] ?? null;
}

export function readField(def: FieldDef, fieldName: string, item: QueryItem): unknown {
  if (def.get) return def.get(item);
  return item[fieldName] ?? item[fieldName.toLowerCase()];
}
