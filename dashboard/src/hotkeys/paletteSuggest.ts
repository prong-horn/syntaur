/**
 * Palette autocomplete engine — pure, deterministic suggestions for the token
 * under the caret. Reuses the shipped AQL lexer (`@shared/query`) and the SAME
 * next-token span reconstruction as `paletteQuery.ts` — no second parser. Never
 * throws: unlexable / half-typed input degrades to no suggestions.
 *
 * Categories (per the token under the caret):
 *  - start-of-input / a bare-word token  → alias prefixes + field names
 *  - a value position right after `field:` → values for that field (enum/list only)
 *  - a complete, already-valid atom        → nothing (don't nag)
 *
 * `replace` is the exact source span of the token being completed, so accepting a
 * suggestion never corrupts the rest of the query (quoted values, IN-lists included).
 *
 * See `claude-info/plans/2026-06-15-command-palette-ui-design.md`.
 */
import { lex, type Token } from '@shared/query';
import { quoteQueryValue } from '@shared/view-filters-query';
import type { EntityKind } from '@shared/search-schema';

export interface SuggestContext {
  /** Prefix → entity kind (from config). Suggested as `prefix:` completions. */
  aliases: Record<string, EntityKind>;
  /** Field names to suggest (PALETTE_FIELDS keys; omit jira/externalid when externalIds=false). */
  fields: string[];
  /** Value sources for the token right after `field:`. Free-form fields yield none. */
  values: {
    status: string[];
    type: string[];
    tag: string[];
    assignee: string[];
    externalid: string[];
  };
}

export interface Suggestion {
  /** Display text. */
  label: string;
  /** Text spliced into the `replace` span on accept. */
  insert: string;
  /** Exact source span [start, end) of the token being completed. */
  replace: [number, number];
  kind: 'prefix' | 'field' | 'value';
}

/** Fields with enumerable values (the rest, e.g. title/search, are free-form). */
const VALUE_FIELDS: ReadonlySet<string> = new Set([
  'status',
  'type',
  'tag',
  'assignee',
  'externalid',
]);

/** Tokens that can stand as a value or a bare word being edited. */
const WORD_TOKENS: ReadonlySet<Token['type']> = new Set([
  'IDENT',
  'STRING',
  'NUMBER',
  'DATE',
  'DURATION',
  'STAR',
]);

const MAX_SUGGESTIONS = 8;

export function suggestPalette(input: string, caret: number, ctx: SuggestContext): Suggestion[] {
  let tokens: Token[];
  try {
    tokens = lex(input);
  } catch {
    return [];
  }
  const n = tokens.length; // tokens[n-1] is EOF with pos === input.length

  // Exact source end of token k — slice to the next token's pos, then trim trailing
  // whitespace. Correct for every token type (STRING quotes, no trailing-ws bleed),
  // unlike `pos + text.length`.
  const end = (k: number): number => {
    const next = k + 1 < n ? tokens[k + 1].pos : input.length;
    return tokens[k].pos + input.slice(tokens[k].pos, next).replace(/\s+$/, '').length;
  };

  // Active token: the one being edited — caret strictly after its start, at/before
  // its end. -1 when the caret sits in a whitespace gap or at the very start.
  let act = -1;
  for (let k = 0; k < n - 1; k++) {
    if (caret > tokens[k].pos && caret <= end(k)) {
      act = k;
      break;
    }
  }

  // Token immediately to the left of the active token / caret.
  let leftIdx = act >= 0 ? act - 1 : -1;
  if (act < 0) {
    for (let k = 0; k < n - 1; k++) {
      if (end(k) <= caret) leftIdx = k;
      else break;
    }
  }

  // ---- Value slot: caret right after `IDENT(field) COLON` (with or without a partial value).
  let valueField: string | null = null;
  let valueReplace: [number, number] | null = null;
  let valueFrag = '';
  if (act >= 0 && tokens[act].type === 'COLON' && tokens[act - 1]?.type === 'IDENT') {
    valueField = tokens[act - 1].text.toLowerCase();
    valueReplace = [caret, caret];
  } else if (
    act >= 0 &&
    WORD_TOKENS.has(tokens[act].type) &&
    tokens[act - 1]?.type === 'COLON' &&
    tokens[act - 2]?.type === 'IDENT'
  ) {
    valueField = tokens[act - 2].text.toLowerCase();
    valueReplace = [tokens[act].pos, end(act)];
    valueFrag = tokens[act].text;
  } else if (
    act < 0 &&
    leftIdx >= 0 &&
    tokens[leftIdx].type === 'COLON' &&
    tokens[leftIdx - 1]?.type === 'IDENT'
  ) {
    valueField = tokens[leftIdx - 1].text.toLowerCase();
    valueReplace = [caret, caret];
  }

  if (valueField !== null) {
    if (!VALUE_FIELDS.has(valueField)) return []; // free-form field → no value suggestions
    const values = ctx.values[valueField as keyof SuggestContext['values']] ?? [];
    const frag = valueFrag.toLowerCase();
    const out: Suggestion[] = [];
    for (const v of values) {
      if (frag && !v.toLowerCase().startsWith(frag)) continue;
      if (v.toLowerCase() === frag) continue; // already fully typed — don't nag
      // Canonical query-value quoting (keywords like `or`, `:`/space, escapes).
      out.push({ label: v, insert: quoteQueryValue(v), replace: valueReplace!, kind: 'value' });
      if (out.length >= MAX_SUGGESTIONS) break;
    }
    return out;
  }

  // ---- Field / prefix slot.
  // Active token is non-word punctuation → nothing to complete here.
  if (act >= 0 && !WORD_TOKENS.has(tokens[act].type)) return [];
  // An IDENT already followed by a colon is a chosen field (complete-ish) → don't nag.
  if (act >= 0 && tokens[act].type === 'IDENT' && tokens[act + 1]?.type === 'COLON') return [];
  // Only suggest a new term where one can legally start.
  if (leftIdx >= 0) {
    const lt = tokens[leftIdx].type;
    const canStart =
      lt === 'AND' ||
      lt === 'OR' ||
      lt === 'NOT' ||
      lt === 'MINUS' ||
      lt === 'LPAREN' ||
      lt === 'RPAREN' ||
      WORD_TOKENS.has(lt);
    if (!canStart) return [];
  }

  const frag = (act >= 0 ? tokens[act].text : '').toLowerCase();
  const replace: [number, number] = act >= 0 ? [tokens[act].pos, end(act)] : [caret, caret];

  const out: Suggestion[] = [];
  for (const [prefix, kind] of Object.entries(ctx.aliases)) {
    if (frag && !prefix.toLowerCase().startsWith(frag)) continue;
    out.push({ label: `${prefix}: (${kind})`, insert: `${prefix}:`, replace, kind: 'prefix' });
  }
  for (const field of ctx.fields) {
    if (frag && !field.toLowerCase().startsWith(frag)) continue;
    out.push({ label: `${field}:`, insert: `${field}:`, replace, kind: 'field' });
  }
  return out.slice(0, MAX_SUGGESTIONS);
}
