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
  /** WS-3 compat window (design §4.5): a human-readable deprecation message.
   * The field still compiles and evaluates, but `compileQuery` surfaces a
   * parse-time warning so queries migrate before the field is removed. */
  deprecated?: string;
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
  // Resolved lifecycle workflow (multi-workflow). Reads the effective
  // `resolvedWorkflow` the loader computes, falling back to the raw override.
  workflow: { kind: 'enum', get: (i) => i['resolvedWorkflow'] ?? i['workflow'] },
  tag: { kind: 'list', get: (i) => i['tags'] },
  tags: { kind: 'list' },
  archived: { kind: 'bool' },
  title: { kind: 'substring' },
  // `search` reads a dedicated `searchText` haystack when the item provides one
  // (so the dashboard can match title + slug + project like its filter box),
  // falling back to `title` when absent. Backward-compatible: title-only when no
  // searchText. The `title` field stays title-only.
  search: { kind: 'substring', get: (i) => i['searchText'] ?? i['title'] },
  created: { kind: 'timestamp' },
  updated: { kind: 'timestamp' },
  completedat: { kind: 'timestamp', get: (i) => i['completedAt'] },
  statusage: { kind: 'duration', get: (i) => i['statusAge'] },

  // ── derived-status dimensions (WS-3 compat aliases, design §4.5) ─────────
  // Post-migration the stored stage IS `status`; `phase` reads the deprecated
  // payload mirror while it lasts and aliases to the stage after. `disposition`
  // aliases to the pause FLAGS. `phaseage` is removed — it evaluates as
  // statusAge (post-migration the stage is the status, so the two coincide)
  // and emits a parse-time deprecation warning.
  phase: { kind: 'enum', get: (i) => i['phase'] ?? i['status'] },
  disposition: {
    kind: 'enum',
    get: (i) =>
      i['disposition'] ?? (i['blocked'] ? 'blocked' : i['parked'] ? 'parked' : 'active'),
  },
  phaseage: {
    kind: 'duration',
    get: (i) => i['phaseAge'] ?? i['statusAge'],
    deprecated: '`phaseAge` is removed (stages ARE the status now) — use `statusAge`',
  },

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
  reworkrequested: { kind: 'bool', get: (i) => i['reworkRequested'] },
  // WS-3 compat: pinning is retired (zero live pins) — always false, with a
  // parse-time deprecation warning (design §4.5).
  pinned: {
    kind: 'bool',
    get: () => false,
    deprecated: '`pinned` is deprecated (pinning was retired) — it always evaluates false',
  },
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
