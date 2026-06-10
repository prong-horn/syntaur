/**
 * AQL recursive-descent parser.
 *
 * Grammar (precedence NOT > AND > OR; implicit AND between adjacent terms):
 *   query        := orExpr EOF | EOF            (empty input → match-all)
 *   orExpr       := andExpr (OR andExpr)*
 *   andExpr      := unary ((AND)? unary)*       (implicit AND)
 *   unary        := NOT unary | MINUS atom | primary
 *   primary      := LPAREN orExpr RPAREN | STAR | atom
 *   atom         := IDENT (COLON valueOrList | OP value)
 *   valueOrList  := LPAREN value (COMMA value)* RPAREN | value
 *   value        := IDENT | STRING | NUMBER | DATE | DURATION
 *
 * Browser-safe (no Node APIs).
 */

import type { AtomNode, ComparisonOp, QueryError, QueryNode, QueryValue } from './ast.js';
import { lex, LexError, type Token, type TokenType } from './lexer.js';

export class ParseError extends Error {
  constructor(
    public pos: number,
    message: string,
  ) {
    super(message);
    this.name = 'ParseError';
  }
}

const VALUE_TOKENS: ReadonlySet<TokenType> = new Set(['IDENT', 'STRING', 'NUMBER', 'DATE', 'DURATION']);
/** Tokens that can begin a term — used to detect implicit AND. */
const TERM_START: ReadonlySet<TokenType> = new Set(['IDENT', 'NOT', 'MINUS', 'LPAREN', 'STAR']);

class Parser {
  private pos = 0;

  constructor(private tokens: Token[]) {}

  private peek(): Token {
    return this.tokens[this.pos];
  }

  private next(): Token {
    return this.tokens[this.pos++];
  }

  private expect(type: TokenType, what: string): Token {
    const tok = this.peek();
    if (tok.type !== type) {
      throw new ParseError(tok.pos, `Expected ${what}, got "${tok.text || tok.type}"`);
    }
    return this.next();
  }

  parseQuery(): QueryNode {
    if (this.peek().type === 'EOF') return { kind: 'all' };
    const node = this.orExpr();
    const tok = this.peek();
    if (tok.type !== 'EOF') {
      throw new ParseError(tok.pos, `Unexpected "${tok.text}" — unbalanced parentheses or stray token`);
    }
    return node;
  }

  private orExpr(): QueryNode {
    const children = [this.andExpr()];
    while (this.peek().type === 'OR') {
      this.next();
      children.push(this.andExpr());
    }
    return children.length === 1 ? children[0] : { kind: 'or', children };
  }

  private andExpr(): QueryNode {
    const children = [this.unary()];
    for (;;) {
      const tok = this.peek();
      if (tok.type === 'AND') {
        this.next();
        children.push(this.unary());
      } else if (TERM_START.has(tok.type)) {
        // implicit AND: adjacent terms
        children.push(this.unary());
      } else {
        break;
      }
    }
    return children.length === 1 ? children[0] : { kind: 'and', children };
  }

  private unary(): QueryNode {
    const tok = this.peek();
    if (tok.type === 'NOT') {
      this.next();
      return { kind: 'not', child: this.unary() };
    }
    if (tok.type === 'MINUS') {
      this.next();
      // `-field:value` sugar — minus binds to a single atom
      const inner = this.peek();
      if (inner.type !== 'IDENT') {
        throw new ParseError(inner.pos, 'Expected a field atom after "-" negation');
      }
      return { kind: 'not', child: this.atom() };
    }
    return this.primary();
  }

  private primary(): QueryNode {
    const tok = this.peek();
    if (tok.type === 'LPAREN') {
      this.next();
      const node = this.orExpr();
      this.expect('RPAREN', '")"');
      return node;
    }
    if (tok.type === 'STAR') {
      this.next();
      return { kind: 'all' };
    }
    if (tok.type === 'IDENT') {
      return this.atom();
    }
    throw new ParseError(tok.pos, `Expected a field, "(", "*", or NOT — got "${tok.text || 'end of query'}"`);
  }

  private atom(): AtomNode {
    const fieldTok = this.expect('IDENT', 'a field name');
    const opTok = this.peek();

    if (opTok.type === 'COLON') {
      this.next();
      const values = this.valueOrList();
      return { kind: 'atom', field: fieldTok.text, op: ':', values, pos: fieldTok.pos };
    }
    if (opTok.type === 'OP') {
      this.next();
      const value = this.value();
      return {
        kind: 'atom',
        field: fieldTok.text,
        op: opTok.text as ComparisonOp,
        values: [value],
        pos: fieldTok.pos,
      };
    }
    throw new ParseError(
      opTok.pos,
      `Expected ":" or a comparison operator after field "${fieldTok.text}"`,
    );
  }

  private valueOrList(): QueryValue[] {
    if (this.peek().type === 'LPAREN') {
      this.next();
      const values = [this.value()];
      while (this.peek().type === 'COMMA') {
        this.next();
        values.push(this.value());
      }
      this.expect('RPAREN', '")" to close the value list');
      return values;
    }
    return [this.value()];
  }

  private value(): QueryValue {
    const tok = this.peek();
    if (!VALUE_TOKENS.has(tok.type)) {
      throw new ParseError(tok.pos, `Expected a value, got "${tok.text || tok.type}"`);
    }
    this.next();
    switch (tok.type) {
      case 'STRING':
        return { type: 'string', raw: tok.text, pos: tok.pos };
      case 'NUMBER':
        return { type: 'number', raw: tok.text, num: tok.num, pos: tok.pos };
      case 'DATE':
        return { type: 'date', raw: tok.text, pos: tok.pos };
      case 'DURATION':
        return { type: 'duration', raw: tok.text, num: tok.num, sign: tok.sign ?? 0, pos: tok.pos };
      default:
        return { type: 'word', raw: tok.text, pos: tok.pos };
    }
  }
}

/** Parse a query string. Returns the AST or structured errors (never throws). */
export function parseQuery(input: string): { ast: QueryNode; errors: [] } | { ast: null; errors: QueryError[] } {
  try {
    const tokens = lex(input);
    const ast = new Parser(tokens).parseQuery();
    return { ast, errors: [] };
  } catch (err) {
    if (err instanceof LexError || err instanceof ParseError) {
      return { ast: null, errors: [{ pos: err.pos, message: err.message }] };
    }
    throw err;
  }
}
