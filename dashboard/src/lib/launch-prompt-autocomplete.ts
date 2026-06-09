// Pure, React-free helpers for the launch-prompt box's `@`-token autocomplete.
// Kept dependency-free (sibling of recreate-flow.ts) so the backend Vitest suite
// can unit-test the tokenizing/suggestion logic without a frontend test runner.
//
// Grammar parity is load-bearing: these MUST match the server resolver
// (src/launch/launch-prompt.ts) — token recognition mirrors its `TOKEN_RE`
// (`@` at start-of-string or after whitespace, then a maximal `[A-Za-z0-9_-]+`
// run) and the warn-vs-resolve decision mirrors its `isValidSlug` + known-set
// check. `assignment` is the reserved token. Warnings here are advisory; the
// server is authoritative at launch.

const SLUG_CHAR = /[A-Za-z0-9_-]/;
/** Mirrors src/utils/slug.ts `isValidSlug`. */
const VALID_SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
/** Mirrors src/launch/launch-prompt.ts `TOKEN_RE`. */
const TOKEN_RE = /(^|\s)@([A-Za-z0-9_-]+)/g;

export const RESERVED_TOKEN = 'assignment';

export interface ActiveToken {
  /** Index of the leading `@`. */
  start: number;
  /** Exclusive end of the maximal token run (may extend past the caret). */
  end: number;
  /** The slug text typed BEFORE the caret (used to rank suggestions). */
  partial: string;
}

/**
 * Find the `@`-token the caret is currently inside, or null. The token's `@`
 * must be at start-of-string or preceded by whitespace (so `user@example` is not
 * a token). The returned range covers the whole token run; `partial` is only the
 * text up to the caret.
 */
export function detectActiveToken(text: string, caret: number): ActiveToken | null {
  const pos = Math.max(0, Math.min(caret, text.length));
  // Walk back over slug chars immediately before the caret to find the `@`.
  let i = pos;
  while (i > 0 && SLUG_CHAR.test(text[i - 1])) i--;
  const atIndex = i - 1;
  if (atIndex < 0 || text[atIndex] !== '@') return null;
  // Word boundary: `@` at start or preceded by whitespace.
  if (atIndex > 0 && !/\s/.test(text[atIndex - 1])) return null;
  // Extend forward over the rest of the token run past the caret.
  let end = pos;
  while (end < text.length && SLUG_CHAR.test(text[end])) end++;
  return { start: atIndex, end, partial: text.slice(atIndex + 1, pos) };
}

/**
 * Rank `@`-token suggestions for a typed partial: `assignment` (reserved) first,
 * then installed playbook slugs — prefix matches before substring matches, all
 * case-insensitive. An empty partial returns every candidate.
 */
export function rankSuggestions(partial: string, slugs: readonly string[]): string[] {
  const candidates = [RESERVED_TOKEN, ...slugs.filter((s) => s !== RESERVED_TOKEN)];
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

/** Replace the active token range with `@<suggestion>`, returning new text + caret. */
export function applySuggestion(
  text: string,
  range: { start: number; end: number },
  suggestion: string,
): { text: string; caret: number } {
  const inserted = `@${suggestion}`;
  return {
    text: text.slice(0, range.start) + inserted + text.slice(range.end),
    caret: range.start + inserted.length,
  };
}

/**
 * Advisory warnings for `@`-tokens that the launch resolver would warn on and
 * leave literal: a malformed token (fails `isValidSlug`) or a well-formed slug
 * not in the installed set. `@assignment` never warns. Decision logic mirrors
 * `resolveLaunchPrompt`; the server remains authoritative at launch.
 */
export function tokenWarnings(
  text: string,
  knownSlugs: ReadonlySet<string> | readonly string[],
): string[] {
  const known = knownSlugs instanceof Set ? knownSlugs : new Set(knownSlugs);
  const warnings: string[] = [];
  TOKEN_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TOKEN_RE.exec(text)) !== null) {
    const token = match[2];
    if (token === RESERVED_TOKEN) continue;
    if (!VALID_SLUG.test(token)) {
      warnings.push(`"@${token}" is not a valid playbook token — it will be left as literal text.`);
    } else if (!known.has(token)) {
      warnings.push(`Playbook "${token}" is not installed — "@${token}" will be left as literal text.`);
    }
  }
  return warnings;
}
