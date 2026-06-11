/**
 * Pure, React-free autocomplete helpers for the AQL QueryInput component.
 *
 * Pattern: mirrors launch-prompt-autocomplete.ts — dependency-free, fully
 * parameterized, node-testable via the root Vitest suite (no DOM required).
 *
 * Suggestion lifecycle:
 *   1. `detectCaretContext` classifies the caret position as being on a FIELD
 *      token or a VALUE token (plus which field) by scanning the input string.
 *   2. `rankFieldSuggestions` ranks known field names by prefix → substring.
 *   3. `getValueSuggestions` returns per-field value candidates from caller-
 *      supplied lists (statuses, priorities, types, assignees, projects, tags)
 *      plus synthetic values (true/false for bool fields, none for sentinels).
 *   4. `applySuggestion` splices the chosen token back into the input string,
 *      quoting values via `quoteQueryValue` when required by AQL lexer rules.
 */

import { queryFieldNames } from '@shared/fact-registry';
import type { FieldRegistry } from '@shared/query';
import { quoteQueryValue } from '@shared/view-filters-query';
import type { FactDeclaration } from '@shared/fact-registry';

// ── CaretContext ──────────────────────────────────────────────────────────────

/** The caret is positioned on a FIELD token (after optional whitespace / boolean operators). */
export interface FieldCaretContext {
  kind: 'field';
  /** The field name fragment typed before the caret (empty string when at word start). */
  partial: string;
  /** Exclusive end of the current field token run in the input string. */
  tokenEnd: number;
  /** Inclusive start of the current field token run in the input string. */
  tokenStart: number;
}

/** The caret is positioned on a VALUE token: after `field:` or `field op `. */
export interface ValueCaretContext {
  kind: 'value';
  /** Resolved field name (lowercased for registry lookup). */
  field: string;
  /** The value fragment typed before the caret (empty string when at value start). */
  partial: string;
  /** Inclusive start of the value token run. */
  tokenStart: number;
  /** Exclusive end of the value token run. */
  tokenEnd: number;
}

export type CaretContext = FieldCaretContext | ValueCaretContext | null;

// Characters that are valid in a field or value IDENT token.
// Mirrors the AQL lexer: IDENT_START = [A-Za-z_], IDENT_CHAR = [A-Za-z0-9_-].
// Values may also be quoted strings — handled specially below.
const IDENT_CHAR = /[A-Za-z0-9_-]/;

/**
 * Classify the caret position in the query input string.
 *
 * Algorithm (left-to-right scan from caret):
 *   1. Walk left over ident chars to find the start of the current run.
 *   2. Walk further left over whitespace to find what precedes this run.
 *   3. If what precedes it is a field:op sequence, we're on a VALUE token.
 *   4. Otherwise we're on a FIELD token.
 *
 * Quoted values: if the caret is inside `"…"`, return a value context with
 * the partial text inside the quotes.
 */
export function detectCaretContext(input: string, caret: number): CaretContext {
  const pos = Math.max(0, Math.min(caret, input.length));

  // Check if caret is inside a quoted string value.
  const quoted = detectInsideQuotes(input, pos);
  if (quoted) return quoted;

  // Walk back to find start of current ident run.
  let tokenStart = pos;
  while (tokenStart > 0 && IDENT_CHAR.test(input[tokenStart - 1])) tokenStart--;

  // Extend forward to find end of current ident run.
  let tokenEnd = pos;
  while (tokenEnd < input.length && IDENT_CHAR.test(input[tokenEnd])) tokenEnd++;

  const partial = input.slice(tokenStart, pos);

  // Look backwards past this token to see if there is `field:` or `field op`
  // before it. We scan from the start of the current run leftwards.
  const before = input.slice(0, tokenStart);
  const fieldOpMatch = before.match(/([A-Za-z_][A-Za-z0-9_-]*)\s*(:|>=|<=|!=|=|>|<)\s*$/);
  if (fieldOpMatch) {
    return {
      kind: 'value',
      field: fieldOpMatch[1].toLowerCase(),
      partial,
      tokenStart,
      tokenEnd,
    };
  }

  // Also handle in-list context: `field:(val1, <here>`
  const inListMatch = before.match(/([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*\([^)]*,\s*$/);
  if (inListMatch) {
    return {
      kind: 'value',
      field: inListMatch[1].toLowerCase(),
      partial,
      tokenStart,
      tokenEnd,
    };
  }

  return {
    kind: 'field',
    partial,
    tokenStart,
    tokenEnd,
  };
}

/** Detect if the caret is inside a `"…"` quoted string. Returns a value
 * context if so, using the preceding field name (if any). */
function detectInsideQuotes(input: string, pos: number): ValueCaretContext | null {
  // Find the nearest unescaped `"` before the caret.
  let quoteStart = -1;
  for (let i = pos - 1; i >= 0; i--) {
    if (input[i] === '"' && (i === 0 || input[i - 1] !== '\\')) {
      quoteStart = i;
      break;
    }
  }
  if (quoteStart < 0) return null;
  // Ensure there's no closing `"` between quoteStart+1 and pos.
  for (let i = quoteStart + 1; i < pos; i++) {
    if (input[i] === '"' && input[i - 1] !== '\\') return null;
  }
  // Find closing quote (at or after pos).
  let quoteEnd = pos;
  while (quoteEnd < input.length && !(input[quoteEnd] === '"' && input[quoteEnd - 1] !== '\\')) {
    quoteEnd++;
  }

  const partial = input.slice(quoteStart + 1, pos);
  const before = input.slice(0, quoteStart);
  const fieldOpMatch = before.match(/([A-Za-z_][A-Za-z0-9_-]*)\s*(:|>=|<=|!=|=|>|<)\s*$/);
  const field = fieldOpMatch ? fieldOpMatch[1].toLowerCase() : '';

  return {
    kind: 'value',
    field,
    partial,
    tokenStart: quoteStart,
    tokenEnd: quoteEnd < input.length ? quoteEnd + 1 : quoteEnd,
  };
}

// ── rankFieldSuggestions ──────────────────────────────────────────────────────

/**
 * Rank field name suggestions for a typed partial: prefix matches first, then
 * substring matches, all case-insensitive. An empty partial returns every field.
 */
export function rankFieldSuggestions(
  partial: string,
  declarations: FactDeclaration[],
): string[] {
  const candidates = queryFieldNames(declarations);
  const p = partial.toLowerCase();
  if (p === '') return candidates;
  const prefix: string[] = [];
  const substring: string[] = [];
  for (const s of candidates) {
    const l = s.toLowerCase();
    if (l.startsWith(p)) prefix.push(s);
    else if (l.includes(p)) substring.push(s);
  }
  return [...prefix, ...substring];
}

// ── ValueSuggestionSources ───────────────────────────────────────────────────

/** Caller-supplied value lists derived from board data / config. */
export interface ValueSuggestionSources {
  statuses: string[];
  priorities: string[];
  types: string[];
  assignees: string[];
  projects: string[];
  tags: string[];
}

/**
 * Return value suggestions for a given field name, filtered by `partial`.
 * Sources are supplied by the caller (no global state).
 *
 * Per-field logic:
 *   - status/type/priority/assignee/project/tags: use the corresponding list.
 *   - Boolean fields (from the registry): offer `true` and `false`.
 *   - assignee / project: additionally offer `none` sentinel.
 *   - Everything else: empty list (freeform).
 */
export function getValueSuggestions(
  field: string,
  partial: string,
  sources: ValueSuggestionSources,
  registry: FieldRegistry,
): string[] {
  const f = field.toLowerCase();
  let candidates: string[] = [];

  switch (f) {
    case 'status':
      candidates = [...sources.statuses];
      break;
    case 'priority':
      candidates = [...sources.priorities];
      break;
    case 'type':
      candidates = [...sources.types];
      break;
    case 'assignee':
      candidates = ['none', ...sources.assignees];
      break;
    case 'project':
      candidates = ['none', ...sources.projects];
      break;
    case 'tag':
    case 'tags':
      candidates = [...sources.tags];
      break;
    case 'archived':
    case 'pinned':
    case 'blocked':
    case 'parked':
      candidates = ['true', 'false'];
      break;
    default: {
      // Check the registry for bool fields (custom facts or built-in booleans).
      const def = registry[f];
      if (def?.kind === 'bool') {
        candidates = ['true', 'false'];
      }
      break;
    }
  }

  if (!candidates.length) return [];

  const p = partial.toLowerCase();
  if (p === '') return candidates;
  return candidates.filter((c) => c.toLowerCase().startsWith(p));
}

// ── applySuggestion ───────────────────────────────────────────────────────────

/**
 * Splice a chosen suggestion token into the input at the caret context range.
 * For FIELD suggestions: insert the field name followed by `:`.
 * For VALUE suggestions: insert `quoteQueryValue(suggestion)` so values that
 * contain special chars (`:`, spaces, etc.) are double-quoted automatically.
 *
 * Returns the new input string and the new caret position (just after the
 * inserted token, ready for the next keystroke).
 */
export function applySuggestion(
  input: string,
  ctx: FieldCaretContext | ValueCaretContext,
  suggestion: string,
): { text: string; caret: number } {
  let inserted: string;

  if (ctx.kind === 'field') {
    // Insert field name + `:` so the user can immediately type a value.
    inserted = `${suggestion}:`;
  } else {
    // Value token: quote if needed (e.g. `agent:codex` needs quotes).
    inserted = quoteQueryValue(suggestion);
  }

  const text =
    input.slice(0, ctx.tokenStart) + inserted + input.slice(ctx.tokenEnd);

  return { text, caret: ctx.tokenStart + inserted.length };
}

