/**
 * Pure helpers for the dual-mode AQL condition editor (no React).
 *
 * One string is the source of truth. The structured builder is a lossless view
 * of a SUPPORTED subgrammar — flat comparisons joined by a single level of
 * AND/OR groups. Anything outside that grammar (NOT, `*`, IN-lists, mixed
 * nesting) returns `null` from {@link astToBuilderModel}, and the editor falls
 * back to raw text without ever flattening the user's condition.
 *
 * Validation goes through the EXACT same `parseQuery` + `compileNode` path the
 * server and doctor use (`validateDeriveCondition`), so a condition the editor
 * calls valid is one the CLI accepts — parity by construction.
 */
import {
  normalizeFactDeclarations,
  acceptFactDeclarations,
  queryFieldNames,
  buildDeriveRegistry,
  type FactDeclaration,
  type RawFactDeclaration,
} from '@shared/fact-registry';
import { parseQuery, type QueryNode, type ComparisonOp } from '@shared/query';
import type { FieldRegistry, FieldKind } from '@shared/query';
import { validateDeriveCondition } from '@shared/derive';

export type BuilderOp = ':' | ComparisonOp;
export type BuilderJoin = 'AND' | 'OR';

export interface BuilderComparison {
  field: string;
  op: BuilderOp;
  /** Raw value source text (unquoted), e.g. `true`, `0`, `high`. */
  value: string;
}

/** A group of comparisons joined by `join`. Single nesting level only. */
export interface BuilderGroup {
  join: BuilderJoin;
  comparisons: BuilderComparison[];
}

/** Top-level join of groups (the opposite join of the groups' inner join). */
export interface BuilderModel {
  outerJoin: BuilderJoin;
  groups: BuilderGroup[];
}

function atomToComparison(node: Extract<QueryNode, { kind: 'atom' }>): BuilderComparison | null {
  // IN-lists (`field:(a, b)`) are beyond the builder grammar.
  if (node.values.length !== 1) return null;
  return { field: node.field, op: node.op, value: node.values[0].raw };
}

/**
 * Convert an AST into the builder model, or `null` if the condition uses
 * grammar the builder can't represent without loss. Supported shapes:
 *  - a single comparison
 *  - a flat AND / flat OR of comparisons
 *  - an OR of (AND-groups | comparisons), or an AND of (OR-groups | comparisons)
 *    — i.e. exactly one level of nesting.
 */
export function astToBuilderModel(ast: QueryNode): BuilderModel | null {
  if (ast.kind === 'atom') {
    const c = atomToComparison(ast);
    return c ? { outerJoin: 'AND', groups: [{ join: 'AND', comparisons: [c] }] } : null;
  }
  if (ast.kind === 'and' || ast.kind === 'or') {
    const outerJoin: BuilderJoin = ast.kind === 'and' ? 'AND' : 'OR';
    const innerKind = ast.kind === 'and' ? 'or' : 'and';
    const innerJoin: BuilderJoin = ast.kind === 'and' ? 'OR' : 'AND';
    const groups: BuilderGroup[] = [];
    for (const child of ast.children) {
      if (child.kind === 'atom') {
        const c = atomToComparison(child);
        if (!c) return null;
        groups.push({ join: innerJoin, comparisons: [c] });
      } else if (child.kind === innerKind) {
        const comps: BuilderComparison[] = [];
        for (const gc of child.children) {
          if (gc.kind !== 'atom') return null;
          const c = atomToComparison(gc);
          if (!c) return null;
          comps.push(c);
        }
        groups.push({ join: innerJoin, comparisons: comps });
      } else {
        return null; // NOT / `*` / same-kind nesting → too complex for the builder
      }
    }
    return { outerJoin, groups };
  }
  return null; // 'not' / 'all'
}

/** Parse a condition string straight to a builder model (null = raw-only). */
export function whenToBuilderModel(when: string): BuilderModel | null {
  const trimmed = when.trim();
  if (trimmed === '' || trimmed === '*') return null;
  const parsed = parseQuery(trimmed);
  if (!parsed.ast) return null;
  return astToBuilderModel(parsed.ast);
}

function comparisonToString(c: BuilderComparison): string {
  return c.op === ':' ? `${c.field}:${c.value}` : `${c.field} ${c.op} ${c.value}`;
}

/** Serialize a builder model back to an AQL string. Multi-comparison groups
 * are parenthesized so precedence is explicit regardless of parser defaults. */
export function builderModelToString(model: BuilderModel): string {
  const parts = model.groups.map((g) => {
    const inner = g.comparisons.map(comparisonToString).join(` ${g.join} `);
    return g.comparisons.length > 1 ? `(${inner})` : inner;
  });
  return parts.join(` ${model.outerJoin} `);
}

/**
 * Validate a single derive condition against the registry. `*` is the caller's
 * concern (the catch-all rung), so it is treated as always-valid here.
 */
export function validateCondition(when: string, registry: FieldRegistry): string | null {
  if (when.trim() === '*') return null;
  if (when.trim() === '') return 'condition is empty';
  return validateDeriveCondition(when, registry);
}

export interface FieldOption {
  /** camelCase display name (what gets written into the condition). */
  name: string;
  kind: FieldKind;
}

/** Run the normalize → accept pipeline on raw editor rows (browser-safe). */
export function acceptedFactsFromRows(rows: RawFactDeclaration[]): FactDeclaration[] {
  return acceptFactDeclarations(normalizeFactDeclarations(rows));
}

/**
 * The derive-condition field vocabulary for autocomplete: the built-in
 * DERIVE_FIELDS plus the accepted custom facts, as camelCase names with their
 * kind (so the builder can pick the right operators/value input). Built by
 * intersecting the camelCase `queryFieldNames` list with the derive registry
 * (whose keys are lowercased).
 */
export function deriveFieldOptions(accepted: FactDeclaration[]): FieldOption[] {
  const registry = buildDeriveRegistry(accepted);
  const out: FieldOption[] = [];
  for (const name of queryFieldNames(accepted)) {
    const def = registry[name.toLowerCase()];
    if (def) out.push({ name, kind: def.kind });
  }
  return out;
}

/** Operators valid for a given field kind (for the builder's op picker). */
export function opsForKind(kind: FieldKind): BuilderOp[] {
  switch (kind) {
    case 'bool':
      return [':'];
    case 'number':
    case 'ordinal':
    case 'duration':
    case 'timestamp':
      return [':', '=', '!=', '<', '<=', '>', '>='];
    default:
      return [':', '!='];
  }
}
