/**
 * Browser-safe fact-vocabulary module.
 *
 * Extracted for the same reason as `saved-view-builder.ts`: both the dashboard
 * (Vite/browser build, `@shared/*` alias) and Node-side modules need these
 * definitions. The ONLY import here is from `./query/index.js` — no
 * Node-coupled modules (no `config.ts`, no `fs`, no `path`).
 *
 * Consumers (`src/lifecycle/derive.ts`, `src/utils/config.ts`) re-export
 * everything from here so no existing import path needs to change.
 */

import { ASSIGNMENT_FIELDS, type FieldRegistry } from './query/index.js';

// ── re-exported type (lives in config.ts; declared here for browser consumers) ──

/**
 * A VALIDATED custom-fact declaration (strict union). bool/number facts are
 * asserted values stored in the `facts:` frontmatter map; attestation facts
 * model "agent reviewed revision with verdict" and carry a revision binding.
 *
 * Re-declared here (mirroring `config.ts`) so the dashboard can import this
 * type without pulling in any Node-only module.
 */
export type FactDeclaration =
  | { name: string; type: 'bool' | 'number' }
  | { name: string; type: 'attestation'; binds: 'plan' | 'commit' | 'none' };

// ── DERIVE_FIELDS ─────────────────────────────────────────────────────────────

/**
 * Registry for derive conditions: facts only. Deliberately excludes
 * timestamps/durations (statusAge, created, …) and identity fields — a derive
 * rule referencing them fails validation, implementing "time-based facts are
 * payload-only flags" with teeth.
 */
export const DERIVE_FIELDS: FieldRegistry = {
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
  blocked: { kind: 'bool' },
  parked: { kind: 'bool' },
  reviewrequested: { kind: 'bool', get: (i) => i['reviewRequested'] },
  pinned: { kind: 'bool' },
};

// ── FactFieldNames ─────────────────────────────────────────────────────────────

/** Canonical export/registry names for one fact declaration. */
export interface FactFieldNames {
  /** Storage key in the `facts:` map = declared name verbatim. */
  storageKey: string;
  /** camelCase exported fact keys (attestations use all five; bool/number
   * only use `fact`). */
  exports: {
    fact: string;
    approved: string;
    changesRequested: string;
    by: string;
    approvedBy: string;
  };
  /** Lowercased registry keys this declaration contributes (1 for bool/number,
   * 5 for attestation) — the collision unit. */
  registryKeys: string[];
}

/**
 * THE one canonical naming helper (Locked Decisions): every consumer derives
 * fact field names here so no path invents its own variant. For bool/number
 * the single export is `<name>`; for attestation the five exports are `<name>`,
 * `<name>Approved`, `<name>ChangesRequested`, `<name>By`, `<name>ApprovedBy`.
 */
export function factFieldNames(decl: FactDeclaration): FactFieldNames {
  const name = decl.name;
  const exportNames = {
    fact: name,
    approved: `${name}Approved`,
    changesRequested: `${name}ChangesRequested`,
    by: `${name}By`,
    approvedBy: `${name}ApprovedBy`,
  };
  const registryKeys =
    decl.type === 'attestation'
      ? [
          exportNames.fact,
          exportNames.approved,
          exportNames.changesRequested,
          exportNames.by,
          exportNames.approvedBy,
        ].map((k) => k.toLowerCase())
      : [exportNames.fact.toLowerCase()];
  return { storageKey: name, exports: exportNames, registryKeys };
}

// ── RawFactDeclaration ─────────────────────────────────────────────────────────

/**
 * A custom-fact declaration EXACTLY as parsed from `statuses.facts` — loose
 * parse (Locked Decisions): every field is a raw string so user input
 * round-trips through serialization even when invalid. The strict
 * {@link FactDeclaration} is derived from this via {@link normalizeFactDeclarations}
 * (defined in `config.ts`, which imports this type).
 */
export interface RawFactDeclaration {
  name: string;
  type: string;
  binds: string | null;
}

// ── normalizeFactDeclarations ─────────────────────────────────────────────────

/**
 * Narrow raw declarations to the strict union, DROPPING malformed rows (bad
 * name format / unknown type / invalid binds) — never throws. The single
 * bridge every consumer crosses before the collision filter
 * (`acceptFactDeclarations`). `validateFactDeclarations` diagnoses the raw rows
 * so doctor can report exactly what this drops.
 *
 * Lives here (browser-safe) so both the Node side and the dashboard client can
 * run the identical normalize→accept pipeline; re-exported from `config.ts` so
 * existing Node-side imports from `config.js` keep resolving.
 */
export function normalizeFactDeclarations(
  raw: RawFactDeclaration[] | null | undefined,
): FactDeclaration[] {
  const out: FactDeclaration[] = [];
  for (const row of raw ?? []) {
    if (!row || typeof row.name !== 'string') continue;
    const name = row.name.trim();
    if (!/^[a-z][a-zA-Z0-9]*$/.test(name)) continue;
    const type = (row.type ?? '').trim();
    if (type === 'bool' || type === 'number') {
      out.push({ name, type });
    } else if (type === 'attestation') {
      const binds = (row.binds ?? 'none').toString().trim() || 'none';
      if (binds === 'plan' || binds === 'commit' || binds === 'none') {
        out.push({ name, type: 'attestation', binds });
      }
    }
  }
  return out;
}

// ── validateFactDeclarations ──────────────────────────────────────────────────

/**
 * Diagnose RAW fact declarations: returns one human-readable problem
 * per malformed/colliding row — exactly what the normalize→accept pipeline will
 * drop, so doctor reports nothing silently. Checks name format, type/binds, and
 * case-insensitive collision of EVERY exported key (the declared name and, for
 * attestations, all four generated names) against `DERIVE_FIELDS`,
 * `ASSIGNMENT_FIELDS`, or an earlier declaration's exported keys. Works with
 * `derive: null` — declarations validate independently of derive rules.
 *
 * KEPT IN LOCKSTEP with {@link acceptFactDeclarations} so doctor reports
 * precisely what the runtime drops. If you change collision semantics here,
 * change them there.
 */
export function validateFactDeclarations(raw: RawFactDeclaration[]): string[] {
  const problems: string[] = [];
  // Owner of each lowercased key: 'built-in' or the declaring fact name. Mirrors
  // acceptFactDeclarations EXACTLY so doctor reports precisely what the runtime
  // drops — atomic per declaration (built-ins always win, first-declared wins),
  // and a declaration's keys are reserved ONLY when the whole declaration is
  // accepted (a built-in-collided declaration reserves nothing, so a later
  // declaration the runtime accepts is not falsely flagged).
  const owners = new Map<string, string>(); // lowercased key → 'built-in' | <fact name>
  for (const key of Object.keys(DERIVE_FIELDS)) owners.set(key, 'built-in');
  for (const key of Object.keys(ASSIGNMENT_FIELDS)) owners.set(key, 'built-in');

  for (const row of raw ?? []) {
    const name = (row?.name ?? '').trim();
    if (!/^[a-z][a-zA-Z0-9]*$/.test(name)) {
      problems.push(
        `fact "${row?.name ?? ''}": invalid name — must match /^[a-z][a-zA-Z0-9]*$/`,
      );
      continue;
    }
    const type = (row.type ?? '').trim();
    if (type !== 'bool' && type !== 'number' && type !== 'attestation') {
      problems.push(
        `fact "${name}": invalid type "${row.type ?? ''}" — expected bool, number, or attestation`,
      );
      continue;
    }
    if (type === 'attestation') {
      const binds = (row.binds ?? 'none').toString().trim() || 'none';
      if (binds !== 'plan' && binds !== 'commit' && binds !== 'none') {
        problems.push(
          `fact "${name}": invalid binds "${row.binds}" — expected plan, commit, or none`,
        );
        continue;
      }
    }
    // Collision check across ALL exported keys (binds is irrelevant to names).
    const decl: FactDeclaration =
      type === 'attestation' ? { name, type, binds: 'none' } : { name, type };
    const keys = factFieldNames(decl).registryKeys;
    const collidingKey = keys.find((k) => owners.has(k));
    if (collidingKey !== undefined) {
      const owner = owners.get(collidingKey)!;
      if (owner === 'built-in') {
        problems.push(`fact "${name}": exported field "${collidingKey}" collides with a built-in field`);
      } else if (owner === name) {
        problems.push(`fact "${name}": duplicate declaration (a fact named "${name}" is already declared)`);
      } else {
        problems.push(`fact "${name}": exported field "${collidingKey}" collides with fact "${owner}"`);
      }
      continue; // atomic: reserve NOTHING for a rejected declaration
    }
    for (const key of keys) owners.set(key, name);
  }
  return problems;
}

// ── acceptFactDeclarations ────────────────────────────────────────────────────

/**
 * THE one collision filter (Locked Decisions): drop any declaration whose
 * registry keys collide (case-insensitively) with a built-in field
 * (`DERIVE_FIELDS` ∪ `ASSIGNMENT_FIELDS`) or an earlier-accepted declaration.
 * Built-ins always win; first-declared wins among duplicates. Never throws — a
 * bad config can't brick recompute; doctor (Task 4) surfaces the same collisions
 * as errors. Returns the ACCEPTED list every consumer builds from.
 *
 * KEPT IN LOCKSTEP with {@link validateFactDeclarations}.
 */
export function acceptFactDeclarations(declarations: FactDeclaration[]): FactDeclaration[] {
  // DERIVE_FIELDS / ASSIGNMENT_FIELDS keys are already lowercase.
  const taken = new Set<string>([
    ...Object.keys(DERIVE_FIELDS),
    ...Object.keys(ASSIGNMENT_FIELDS),
  ]);
  const accepted: FactDeclaration[] = [];
  for (const decl of declarations) {
    const keys = factFieldNames(decl).registryKeys;
    if (keys.some((k) => taken.has(k))) continue; // collision — drop
    for (const k of keys) taken.add(k);
    accepted.push(decl);
  }
  return accepted;
}

// ── addFactFields ─────────────────────────────────────────────────────────────

/** Add one accepted declaration's fields to a registry (shared by derive +
 * query registry builders so both speak the identical vocabulary). */
export function addFactFields(registry: FieldRegistry, decl: FactDeclaration): void {
  const names = factFieldNames(decl);
  if (decl.type === 'attestation') {
    registry[names.exports.fact.toLowerCase()] = { kind: 'bool', get: (i) => i[names.exports.fact] };
    registry[names.exports.approved.toLowerCase()] = {
      kind: 'bool',
      get: (i) => i[names.exports.approved],
    };
    registry[names.exports.changesRequested.toLowerCase()] = {
      kind: 'bool',
      get: (i) => i[names.exports.changesRequested],
    };
    // actor sets register as `list` — `:` equality + IN lists already have
    // contains semantics there (query/fields.ts kind 'list').
    registry[names.exports.by.toLowerCase()] = { kind: 'list', get: (i) => i[names.exports.by] };
    registry[names.exports.approvedBy.toLowerCase()] = {
      kind: 'list',
      get: (i) => i[names.exports.approvedBy],
    };
  } else {
    registry[names.exports.fact.toLowerCase()] = {
      kind: decl.type,
      get: (i) => i[names.exports.fact],
    };
  }
}

// ── buildDeriveRegistry / buildQueryRegistry ──────────────────────────────────

/**
 * Build the DERIVE registry (facts only) from the ACCEPTED declaration list.
 * Callers run the normalize→accept pipeline first and build ONE registry per
 * config resolution (so the WeakMap compile cache stays warm across sweeps).
 */
export function buildDeriveRegistry(accepted: FactDeclaration[]): FieldRegistry {
  const registry: FieldRegistry = { ...DERIVE_FIELDS };
  for (const decl of accepted) addFactFields(registry, decl);
  return registry;
}

/**
 * Build the QUERY registry (full assignment vocabulary) from the ACCEPTED list —
 * custom entries merged over `ASSIGNMENT_FIELDS` for ls/dashboard query paths.
 * Same accepted input, same entries as {@link buildDeriveRegistry}.
 */
export function buildQueryRegistry(accepted: FactDeclaration[]): FieldRegistry {
  const registry: FieldRegistry = { ...ASSIGNMENT_FIELDS };
  for (const decl of accepted) addFactFields(registry, decl);
  return registry;
}

// ── queryFieldNames ───────────────────────────────────────────────────────────

/**
 * The canonical camelCase field names available for AQL autocomplete in the
 * dashboard. Returns the static built-in list PLUS each declaration's exported
 * field names from `factFieldNames`.
 *
 * NOTE: the built-in list is a hand-maintained camelCase display mapping of the
 * `ASSIGNMENT_FIELDS` registry keys (which are lowercase, e.g. `completedat` →
 * `completedAt`). It is NOT derived at runtime, so it must be kept in sync with
 * `query/fields.ts` whenever a built-in queryable field is added or renamed.
 */
export function queryFieldNames(declarations: FactDeclaration[]): string[] {
  // Hand-maintained camelCase display names for the lowercase ASSIGNMENT_FIELDS
  // registry keys (fields.ts). Keep in sync with that registry.
  const builtins: string[] = [
    'status',
    'priority',
    'type',
    'assignee',
    'project',
    'tag',
    'tags',
    'archived',
    'title',
    'search',
    'created',
    'updated',
    'completedAt',
    'statusAge',
    'phase',
    'disposition',
    'phaseAge',
    'hasRealObjective',
    'acRealTotal',
    'acRealChecked',
    'acAllChecked',
    'planExists',
    'planApproved',
    'workspaceSet',
    'implementationStarted',
    'depsSatisfied',
    'unresolvedQuestions',
    'progressStaleDays',
    'blocked',
    'parked',
    'reviewRequested',
    'pinned',
  ];

  const custom: string[] = [];
  for (const decl of declarations) {
    const names = factFieldNames(decl);
    if (decl.type === 'attestation') {
      custom.push(
        names.exports.fact,
        names.exports.approved,
        names.exports.changesRequested,
        names.exports.by,
        names.exports.approvedBy,
      );
    } else {
      custom.push(names.exports.fact);
    }
  }

  return [...builtins, ...custom];
}
