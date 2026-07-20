/**
 * AQL — Assignment Query Language. Public surface.
 *
 * One engine, many consumers: derive rules (phase ladder / disposition),
 * `syntaur ls --query`, and dashboard filters all share this module.
 * Browser-safe: no Node-only imports anywhere under `src/utils/query/`.
 */

import type { QueryError, QueryNode } from './ast.js';
import { compileNode, CompileError, type EvalContext, type Predicate } from './evaluate.js';
import { ASSIGNMENT_FIELDS, resolveField, type FieldRegistry, type QueryItem } from './fields.js';
import { parseQuery } from './parser.js';

export type { QueryError, QueryNode, ComparisonOp } from './ast.js';
export { lex, LexError } from './lexer.js';
export type { Token, TokenType } from './lexer.js';
export { parseQuery, ParseError } from './parser.js';
export { compileNode, CompileError } from './evaluate.js';
export type { EvalContext, Predicate } from './evaluate.js';
export {
  ASSIGNMENT_FIELDS,
  PRIORITY_ORDER,
  resolveField,
  readField,
} from './fields.js';
export type { FieldDef, FieldKind, FieldRegistry, QueryItem } from './fields.js';

export interface CompiledQuery {
  predicate: Predicate;
  ast: QueryNode;
}

/** A non-blocking parse-time diagnostic (WS-3 compat window, design §4.5):
 * the query still compiles, but references a deprecated field. */
export interface QueryWarning {
  pos: number;
  field: string;
  message: string;
}

/**
 * Collect a parse-time deprecation warning for every atom referencing a field
 * whose {@link FieldDef.deprecated} is set. Shared by the CLI (`syntaur ls`)
 * and the dashboard query input so the two surfaces warn identically.
 */
export function collectDeprecationWarnings(
  node: QueryNode,
  registry: FieldRegistry,
): QueryWarning[] {
  const warnings: QueryWarning[] = [];
  const walk = (n: QueryNode): void => {
    switch (n.kind) {
      case 'atom': {
        const def = resolveField(registry, n.field);
        if (def?.deprecated) warnings.push({ pos: n.pos, field: n.field, message: def.deprecated });
        break;
      }
      case 'and':
      case 'or':
        for (const c of n.children) walk(c);
        break;
      case 'not':
        walk(n.child);
        break;
      case 'all':
        break;
    }
  };
  walk(node);
  return warnings;
}

/**
 * Parse + compile a query against a field registry. Returns the compiled
 * predicate or structured errors (never throws on user input). A successful
 * compile also carries `warnings` — non-blocking deprecation diagnostics.
 */
export function compileQuery(
  input: string,
  registry: FieldRegistry = ASSIGNMENT_FIELDS,
):
  | { query: CompiledQuery; errors: []; warnings: QueryWarning[] }
  | { query: null; errors: QueryError[]; warnings: [] } {
  const parsed = parseQuery(input);
  if (!parsed.ast) return { query: null, errors: parsed.errors, warnings: [] };
  try {
    const predicate = compileNode(parsed.ast, registry);
    return {
      query: { predicate, ast: parsed.ast },
      errors: [],
      warnings: collectDeprecationWarnings(parsed.ast, registry),
    };
  } catch (err) {
    if (err instanceof CompileError) return { query: null, errors: err.errors, warnings: [] };
    throw err;
  }
}

/** Validate a query (parse + field check) without evaluating — for doctor/config checks. */
export function validateQuery(input: string, registry: FieldRegistry = ASSIGNMENT_FIELDS): QueryError[] {
  return compileQuery(input, registry).errors;
}

/** Convenience: filter a list of items with a compiled query. */
export function runQuery(items: QueryItem[], compiled: CompiledQuery, ctx: EvalContext): QueryItem[] {
  return items.filter((item) => compiled.predicate(item, ctx));
}
