/**
 * Palette query layer — splits a raw Cmd+K query into an AQL filter sub-expression
 * (the GATE) and free-text terms (the fuzzy ORDER), and defines the palette's AQL
 * field registry. Reuses the shipped AQL engine (`@shared/query`) — no second
 * parser. Pure and deterministic; trivially unit-testable.
 *
 * See `claude-info/plans/2026-06-13-command-palette-search-design.md`.
 */
import { compileQuery, lex, LexError, type FieldRegistry, type QueryItem, type Token } from '@shared/query';
import type { PaletteEntry } from './paletteIndex';

/** Short type aliases desugar to a canonical `kind:<entityType>` atom. */
const TYPE_ALIASES: Record<string, PaletteEntry['type']> = {
  a: 'assignment',
  p: 'project',
  t: 'todo',
  s: 'server',
  pb: 'playbook',
};

/**
 * Sentinel returned by the `assignee`/`project` accessors when the entry does not
 * carry that property at all (page/server/todo/playbook). It is non-"none" so the
 * `noneSentinel` `:none` check does NOT match field-less entities — only entities
 * that genuinely have the field set to null/'' match `field:none`. Restores the
 * design invariant "an atom referencing a field an entity lacks is false for it".
 */
const ABSENT: unique symbol = Symbol('absent');

/** Collapse internal whitespace runs to a single space and trim. */
function normalizeWs(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** Tokens that may stand as an atom value (mirrors the AQL parser's VALUE_TOKENS). */
const VALUE_TOKENS: ReadonlySet<Token['type']> = new Set([
  'IDENT',
  'STRING',
  'NUMBER',
  'DATE',
  'DURATION',
]);

function externalIdHaystack(item: QueryItem): string {
  const ids = item['externalIds'];
  if (!Array.isArray(ids)) return '';
  return ids
    .map((e) =>
      e && typeof e === 'object'
        ? `${(e as { system?: unknown }).system}:${(e as { id?: unknown }).id}`
        : '',
    )
    .join(' ');
}

function jiraHaystack(item: QueryItem): string {
  const ids = item['externalIds'];
  if (!Array.isArray(ids)) return '';
  return ids
    .filter((e): e is { system: string; id: unknown } => {
      const sys = (e as { system?: unknown })?.system;
      return typeof sys === 'string' && sys.toLowerCase() === 'jira';
    })
    .map((e) => String(e.id))
    .join(' ');
}

/**
 * The palette's AQL vocabulary. The index entry IS the `QueryItem` the gate
 * evaluates, so accessors read the entry's own keys. An atom referencing a field
 * an entity lacks evaluates to `false` for it (so `status:done` narrows to
 * assignments/todos, `jira:X` to entities carrying external IDs) — no special
 * multi-entity casing needed. `type` (frontmatter type) is distinct from `kind`
 * (the entity kind, target of the aliases).
 */
export const PALETTE_FIELDS: FieldRegistry = {
  kind: { kind: 'enum', get: (i) => i['type'] },
  status: { kind: 'enum' },
  tag: { kind: 'list', get: (i) => i['tags'] },
  tags: { kind: 'list' },
  assignee: { kind: 'string', noneSentinel: true, get: (i) => ('assignee' in i ? i['assignee'] : ABSENT) },
  type: { kind: 'enum', get: (i) => i['assignmentType'] },
  project: { kind: 'string', noneSentinel: true, get: (i) => ('project' in i ? i['project'] : ABSENT) },
  externalid: { kind: 'substring', get: externalIdHaystack },
  jira: { kind: 'substring', get: jiraHaystack },
  title: { kind: 'substring' },
  search: { kind: 'substring', get: (i) => i['searchText'] ?? i['title'] },
};

export interface SplitResult {
  /** AQL filter sub-expression (alias-expanded); '' when there are no filters. */
  aqlExpr: string;
  /** Free-text terms for the fuzzy ranker; '' in explicit-boolean mode. */
  fuzzy: string;
}

/**
 * Split a raw palette query into `{ aqlExpr, fuzzy }`.
 *
 * - Type aliases (`a:`/`p:`/`t:`/`s:`/`pb:`) desugar to `kind:<entityType>`; any
 *   value after the alias colon is left for normal classification (a bare word →
 *   free text; another atom → its own atom).
 * - A token run forms a filter atom only if its IDENT resolves in `PALETTE_FIELDS`;
 *   unknown `foo:bar` and bare words stay literal free text.
 * - A trailing in-progress atom (`status:` with no value) degrades to free text.
 * - Explicit boolean (a grouping paren, or `OR`) routes the whole input to AQL with
 *   no fuzzy. `AND` is NOT a trigger (it is the implicit default and appears in
 *   natural free text). A `(` immediately after a `:` is an IN-list, not grouping.
 * - Unlexable input (chars the AQL lexer rejects, e.g. `/`, `.`, `@`) is treated
 *   wholly as free text — never throws.
 * - Free text is reconstructed from original-input source spans (token positions),
 *   preserving quotes, spacing, and punctuation.
 */
export function splitPaletteQuery(input: string): SplitResult {
  let tokens: Token[];
  try {
    tokens = lex(input);
  } catch (err) {
    if (err instanceof LexError) return { aqlExpr: '', fuzzy: normalizeWs(input) };
    throw err;
  }
  const n = tokens.length; // tokens[n-1] is EOF with pos === input.length

  // Source slice for the half-open token-index range [from, to).
  const slice = (from: number, to: number): string =>
    input.slice(tokens[from].pos, to < n ? tokens[to].pos : input.length);

  // Explicit-boolean detection: a grouping LPAREN (not an IN-list paren, which
  // immediately follows a COLON) or a top-level OR ⇒ treat the whole input as AQL.
  let explicit = false;
  for (let k = 0; k < n; k++) {
    const t = tokens[k];
    if (t.type === 'OR' || (t.type === 'LPAREN' && (k === 0 || tokens[k - 1].type !== 'COLON'))) {
      explicit = true;
      break;
    }
  }
  if (explicit) {
    // Expand aliases, then keep the whole expression only if it compiles; else it
    // is not a usable gate, so fall back to ranking the raw input as free text.
    const expr = normalizeWs(expandAliasesInSource(input, tokens, n));
    return compileQuery(expr, PALETTE_FIELDS).query
      ? { aqlExpr: expr, fuzzy: '' }
      : { aqlExpr: '', fuzzy: normalizeWs(input) };
  }

  const aqlParts: string[] = [];
  const fuzzyParts: string[] = [];
  let i = 0;
  let freeStart = 0;

  const flushFree = (end: number) => {
    if (end > freeStart) {
      const s = normalizeWs(slice(freeStart, end));
      if (s) fuzzyParts.push(s);
    }
  };

  while (i < n - 1) {
    // 1. Type-alias prefix (optionally negated): [MINUS|NOT]? IDENT(alias) COLON
    //    → [-|NOT ]kind:<entityType>. Any value after the colon is reclassified.
    const alias = matchAlias(tokens, i);
    if (alias) {
      flushFree(i);
      aqlParts.push(alias.atom);
      i = alias.end;
      freeStart = i;
      continue;
    }

    // 2. Registry field atom — accepted only if its source actually compiles, so
    //    the assembled aqlExpr is guaranteed valid. Malformed shapes that lex like
    //    an atom (`status:()`, `status:(a b)`, `status>done`) degrade to free text.
    const atomEnd = matchFieldAtom(tokens, i, n);
    if (atomEnd !== null) {
      const src = slice(i, atomEnd).trim();
      if (compileQuery(src, PALETTE_FIELDS).query) {
        flushFree(i);
        aqlParts.push(src);
        i = atomEnd;
        freeStart = i;
        continue;
      }
      // Not a compilable atom → leave its span in the free-text run.
      i = atomEnd;
      continue;
    }

    // 3. Part of a free-text run.
    i++;
  }
  flushFree(n - 1);

  return { aqlExpr: aqlParts.join(' '), fuzzy: fuzzyParts.join(' ') };
}

/**
 * Match a type-alias atom at `start`: `[MINUS|NOT]? IDENT(alias) COLON`. Returns the
 * canonical `kind:<entityType>` atom (with negation prefix) and the exclusive end
 * token index, or null. The value after the colon is intentionally NOT consumed —
 * it is reclassified by the main walk (bare word → free text; atom → its own atom).
 */
function matchAlias(tokens: Token[], start: number): { atom: string; end: number } | null {
  let j = start;
  let neg = '';
  if (tokens[j].type === 'MINUS') {
    neg = '-';
    j++;
  } else if (tokens[j].type === 'NOT') {
    neg = 'NOT ';
    j++;
  }
  const ident = tokens[j];
  if (!ident || ident.type !== 'IDENT') return null;
  const entity = TYPE_ALIASES[ident.text.toLowerCase()];
  if (!entity || tokens[j + 1]?.type !== 'COLON') return null;
  return { atom: `${neg}kind:${entity}`, end: j + 2 };
}

/**
 * If a complete registry-field atom starts at `start`, return its exclusive end
 * token index; else null. Forms: `[MINUS|NOT]? IDENT (COLON value | COLON inList |
 * OP value)` where the IDENT resolves in `PALETTE_FIELDS`. Structural only — the
 * caller validates compilability.
 */
function matchFieldAtom(tokens: Token[], start: number, n: number): number | null {
  let j = start;
  if (tokens[j].type === 'MINUS' || tokens[j].type === 'NOT') j++;
  const ident = tokens[j];
  if (!ident || ident.type !== 'IDENT') return null;
  if (!Object.prototype.hasOwnProperty.call(PALETTE_FIELDS, ident.text.toLowerCase())) return null;

  const op = tokens[j + 1];
  if (!op) return null;

  if (op.type === 'COLON') {
    const v = tokens[j + 2];
    if (!v) return null;
    if (v.type === 'LPAREN') {
      // IN-list: balance to the matching RPAREN.
      let depth = 0;
      for (let k = j + 2; k < n; k++) {
        if (tokens[k].type === 'LPAREN') depth++;
        else if (tokens[k].type === 'RPAREN') {
          depth--;
          if (depth === 0) return k + 1;
        } else if (tokens[k].type === 'EOF') return null;
      }
      return null;
    }
    return VALUE_TOKENS.has(v.type) ? j + 3 : null;
  }

  if (op.type === 'OP') {
    const v = tokens[j + 2];
    return v && VALUE_TOKENS.has(v.type) ? j + 3 : null;
  }

  return null;
}

/**
 * Rewrite the source so any `IDENT(alias) COLON` run becomes `kind:<entityType> `,
 * leaving the rest verbatim — used for explicit-boolean queries so `a: OR p:` and
 * `(a:)` gate correctly. The trailing space keeps a glued value (`a:payment`)
 * from fusing onto the expansion.
 */
function expandAliasesInSource(input: string, tokens: Token[], n: number): string {
  let out = '';
  let cursor = 0;
  for (let k = 0; k < n; k++) {
    const t = tokens[k];
    if (
      t.type === 'IDENT' &&
      Object.prototype.hasOwnProperty.call(TYPE_ALIASES, t.text.toLowerCase()) &&
      tokens[k + 1]?.type === 'COLON'
    ) {
      out += input.slice(cursor, t.pos) + `kind:${TYPE_ALIASES[t.text.toLowerCase()]} `;
      cursor = tokens[k + 1].pos + 1; // skip the alias IDENT and its colon
    }
  }
  out += input.slice(cursor);
  return out;
}
