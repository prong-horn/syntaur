/**
 * AQL — Assignment Query Language. Public surface.
 *
 * One engine, many consumers: derive rules (phase ladder / disposition),
 * `syntaur ls --query`, and dashboard filters all share this module.
 * Browser-safe: no Node-only imports anywhere under `src/utils/query/`.
 */

import type { QueryError, QueryNode } from './ast.js';
import { compileNode, CompileError, type EvalContext, type Predicate } from './evaluate.js';
import { ASSIGNMENT_FIELDS, type FieldRegistry, type QueryItem } from './fields.js';
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

/**
 * Parse + compile a query against a field registry. Returns the compiled
 * predicate or structured errors (never throws on user input).
 */
export function compileQuery(
  input: string,
  registry: FieldRegistry = ASSIGNMENT_FIELDS,
): { query: CompiledQuery; errors: [] } | { query: null; errors: QueryError[] } {
  const parsed = parseQuery(input);
  if (!parsed.ast) return { query: null, errors: parsed.errors };
  try {
    const predicate = compileNode(parsed.ast, registry);
    return { query: { predicate, ast: parsed.ast }, errors: [] };
  } catch (err) {
    if (err instanceof CompileError) return { query: null, errors: err.errors };
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
