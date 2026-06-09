/**
 * AQL — Assignment Query Language. AST node types.
 *
 * Browser-safe: this module (and the whole `src/utils/query/` engine) must not
 * import any Node-only API — the dashboard evaluates queries client-side.
 * See claude-info/plans/2026-06-03-assignment-query-language-design.md (grammar)
 * and 2026-06-09-derived-status-and-rules-design.md (derive-rule consumer).
 */

export type ComparisonOp = '<' | '>' | '<=' | '>=' | '=' | '!=';

/** A literal value appearing in a query. */
export interface QueryValue {
  type: 'word' | 'string' | 'number' | 'date' | 'duration';
  /** Source text (unquoted for strings). */
  raw: string;
  /** Numeric payload: number value, or duration magnitude in ms. */
  num?: number;
  /** Duration sign: -1 = past (`-36h`), +1 = future (`+2d`), 0 = bare (`36h`, "ago" vs timestamps). */
  sign?: -1 | 0 | 1;
  /** Source position (offset into the query string) for error reporting. */
  pos: number;
}

export interface AtomNode {
  kind: 'atom';
  field: string;
  /** ':' = equality/membership; comparison ops compare scalars. */
  op: ':' | ComparisonOp;
  /** Multiple values only for the `field:(a, b)` IN-list form. */
  values: QueryValue[];
  /** Position of the field token, for unknown-field errors. */
  pos: number;
}

export interface AndNode {
  kind: 'and';
  children: QueryNode[];
}

export interface OrNode {
  kind: 'or';
  children: QueryNode[];
}

export interface NotNode {
  kind: 'not';
  child: QueryNode;
}

/** `*` — matches everything (used as the bottom phase-ladder rung). */
export interface MatchAllNode {
  kind: 'all';
}

export type QueryNode = AtomNode | AndNode | OrNode | NotNode | MatchAllNode;

/** Structured parse/compile error with source position. */
export interface QueryError {
  pos: number;
  message: string;
}
