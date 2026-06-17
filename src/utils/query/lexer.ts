/**
 * AQL lexer. Tokenizes a query string; positions are byte offsets for
 * structured errors. Browser-safe (no Node APIs).
 */

export type TokenType =
  | 'IDENT'
  | 'STRING'
  | 'NUMBER'
  | 'DATE'
  | 'DURATION'
  | 'COLON'
  | 'LPAREN'
  | 'RPAREN'
  | 'COMMA'
  | 'OP' // < > <= >= = !=
  | 'MINUS' // negation prefix (`-field:value`)
  | 'STAR'
  | 'AND'
  | 'OR'
  | 'NOT'
  | 'EOF';

export interface Token {
  type: TokenType;
  /** Source text (for STRING: the unquoted contents). */
  text: string;
  pos: number;
  /** DURATION: magnitude in ms. NUMBER: numeric value. */
  num?: number;
  /** DURATION sign: -1, +1, or 0 (bare). */
  sign?: -1 | 0 | 1;
}

export class LexError extends Error {
  constructor(
    public pos: number,
    message: string,
  ) {
    super(message);
    this.name = 'LexError';
  }
}

/** Duration unit → milliseconds. `m` ≈ 30d (month), `mo` explicit month, `y` ≈ 365d. */
const DURATION_MS: Record<string, number> = {
  h: 3_600_000,
  d: 86_400_000,
  w: 7 * 86_400_000,
  m: 30 * 86_400_000,
  mo: 30 * 86_400_000,
  y: 365 * 86_400_000,
};

const IDENT_START = /[A-Za-z_]/;
const IDENT_CHAR = /[A-Za-z0-9_-]/;
// Anchored so a trailing digit/dash can't be swallowed into a "date" (e.g.
// `2026-06-1623` must NOT lex as DATE `2026-06-16` + `23`). Calendar validity
// (month/day ranges) is enforced later in the evaluator with positional errors.
const DATE_RE = /^\d{4}-\d{2}-\d{2}(?![\d-])/;

export function lex(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  const numberOrDuration = (start: number, sign: -1 | 0 | 1): Token => {
    let j = i;
    while (j < input.length && /\d/.test(input[j])) j++;
    const digits = input.slice(i, j);
    // unit suffix?
    let unit = '';
    while (j < input.length && /[a-z]/i.test(input[j])) {
      unit += input[j];
      j++;
    }
    i = j;
    if (unit.length > 0) {
      const ms = DURATION_MS[unit.toLowerCase()];
      if (ms === undefined) {
        throw new LexError(start, `Unknown duration unit "${unit}" (expected h, d, w, m, mo, or y)`);
      }
      return {
        type: 'DURATION',
        text: input.slice(start, j),
        pos: start,
        num: parseInt(digits, 10) * ms,
        sign,
      };
    }
    if (sign !== 0) {
      // signed bare number — only meaningful as a duration; treat as number with sign applied
      return { type: 'NUMBER', text: input.slice(start, j), pos: start, num: sign * parseInt(digits, 10) };
    }
    return { type: 'NUMBER', text: digits, pos: start, num: parseInt(digits, 10) };
  };

  while (i < input.length) {
    const c = input[i];
    const start = i;

    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i++;
      continue;
    }
    if (c === '(') {
      tokens.push({ type: 'LPAREN', text: c, pos: start });
      i++;
      continue;
    }
    if (c === ')') {
      tokens.push({ type: 'RPAREN', text: c, pos: start });
      i++;
      continue;
    }
    if (c === ',') {
      tokens.push({ type: 'COMMA', text: c, pos: start });
      i++;
      continue;
    }
    if (c === ':') {
      tokens.push({ type: 'COLON', text: c, pos: start });
      i++;
      continue;
    }
    if (c === '*') {
      tokens.push({ type: 'STAR', text: c, pos: start });
      i++;
      continue;
    }
    if (c === '<' || c === '>') {
      if (input[i + 1] === '=') {
        tokens.push({ type: 'OP', text: c + '=', pos: start });
        i += 2;
      } else {
        tokens.push({ type: 'OP', text: c, pos: start });
        i++;
      }
      continue;
    }
    if (c === '!') {
      if (input[i + 1] === '=') {
        tokens.push({ type: 'OP', text: '!=', pos: start });
        i += 2;
        continue;
      }
      throw new LexError(start, `Unexpected "!" (did you mean "!="?)`);
    }
    if (c === '=') {
      // accept both `=` and `==`
      i += input[i + 1] === '=' ? 2 : 1;
      tokens.push({ type: 'OP', text: '=', pos: start });
      continue;
    }
    if (c === '"' || c === "'") {
      const quote = c;
      let j = i + 1;
      let out = '';
      while (j < input.length && input[j] !== quote) {
        if (input[j] === '\\' && j + 1 < input.length) {
          out += input[j + 1];
          j += 2;
        } else {
          out += input[j];
          j++;
        }
      }
      if (j >= input.length) throw new LexError(start, 'Unterminated string literal');
      tokens.push({ type: 'STRING', text: out, pos: start });
      i = j + 1;
      continue;
    }
    if (c === '-' || c === '+') {
      if (/\d/.test(input[i + 1] ?? '')) {
        const sign = c === '-' ? -1 : 1;
        i++;
        tokens.push(numberOrDuration(start, sign));
        continue;
      }
      if (c === '-') {
        tokens.push({ type: 'MINUS', text: '-', pos: start });
        i++;
        continue;
      }
      throw new LexError(start, 'Unexpected "+"');
    }
    if (/\d/.test(c)) {
      const dateMatch = input.slice(i).match(DATE_RE);
      if (dateMatch) {
        tokens.push({ type: 'DATE', text: dateMatch[0], pos: start });
        i += dateMatch[0].length;
        continue;
      }
      tokens.push(numberOrDuration(start, 0));
      continue;
    }
    if (IDENT_START.test(c)) {
      let j = i + 1;
      while (j < input.length && IDENT_CHAR.test(input[j])) j++;
      const word = input.slice(i, j);
      const kw = word.toLowerCase();
      if (kw === 'and') tokens.push({ type: 'AND', text: word, pos: start });
      else if (kw === 'or') tokens.push({ type: 'OR', text: word, pos: start });
      else if (kw === 'not') tokens.push({ type: 'NOT', text: word, pos: start });
      else tokens.push({ type: 'IDENT', text: word, pos: start });
      i = j;
      continue;
    }
    throw new LexError(start, `Unexpected character "${c}"`);
  }

  tokens.push({ type: 'EOF', text: '', pos: input.length });
  return tokens;
}
