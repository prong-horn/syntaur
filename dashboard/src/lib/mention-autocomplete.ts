// Pure, React-free primitives for `@`-token autocomplete in a text box. Kept
// dependency-free (sibling of recreate.ts) so the backend Vitest suite can
// unit-test the tokenizing/insertion logic without a frontend test runner.
//
// Grammar parity is load-bearing: these MUST match the server's mention parser
// (`src/chat/router.ts` `parseMentions`) — token recognition mirrors its token
// regex (`@` at start-of-string or after whitespace, then a maximal
// `[A-Za-z0-9_-]+` run). Ranking is the caller's business: the chat composer
// ranks over attached agent ids (`lib/chat-format.ts` `rankAgentTokens`).

const SLUG_CHAR = /[A-Za-z0-9_-]/;

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
