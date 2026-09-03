// Launch-prompt-only `@`-token helpers: the reserved tokens, the playbook
// ranking and the advisory warnings. The tokenizing/insertion primitives moved
// to `mention-autocomplete.ts` because the chat composer needs them and is not
// launch code; they are re-exported here so the launch-prompt components keep
// one import site.
//
// Grammar parity is load-bearing: these MUST match the server resolver
// (src/launch/launch-prompt.ts) — the warn-vs-resolve decision mirrors its
// `isValidSlug` + known-set check. `assignment` and `worktree` are the reserved
// tokens. Warnings here are advisory; the server is authoritative at launch.

export { applySuggestion, detectActiveToken, type ActiveToken } from './mention-autocomplete';

/** Mirrors src/utils/slug.ts `isValidSlug`. */
const VALID_SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
/** Mirrors src/launch/launch-prompt.ts `TOKEN_RE`. */
const TOKEN_RE = /(^|\s)@([A-Za-z0-9_-]+)/g;

/** Reserved `@`-tokens the server resolves (not playbook slugs). */
export const RESERVED_TOKENS = ['assignment', 'worktree'] as const;
/** @deprecated kept for back-compat; prefer `RESERVED_TOKENS`. */
export const RESERVED_TOKEN = 'assignment';

/**
 * Rank `@`-token suggestions for a typed partial: reserved tokens
 * (`assignment`, `worktree`) first, then installed playbook slugs — prefix
 * matches before substring matches, all case-insensitive. An empty partial
 * returns every candidate.
 */
export function rankSuggestions(partial: string, slugs: readonly string[]): string[] {
  const reserved = RESERVED_TOKENS as readonly string[];
  const candidates = [...reserved, ...slugs.filter((s) => !reserved.includes(s))];
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

/**
 * Advisory warnings for `@`-tokens that the launch resolver would warn on and
 * leave literal: a malformed token (fails `isValidSlug`) or a well-formed slug
 * not in the installed set. Reserved tokens (`@assignment`, `@worktree`) never
 * warn. Decision logic mirrors `resolveLaunchPrompt`; the server remains
 * authoritative at launch.
 */
export function tokenWarnings(
  text: string,
  knownSlugs: ReadonlySet<string> | readonly string[],
): string[] {
  const known = knownSlugs instanceof Set ? knownSlugs : new Set(knownSlugs);
  const reserved = RESERVED_TOKENS as readonly string[];
  const warnings: string[] = [];
  TOKEN_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TOKEN_RE.exec(text)) !== null) {
    const token = match[2];
    if (reserved.includes(token)) continue;
    if (!VALID_SLUG.test(token)) {
      warnings.push(`"@${token}" is not a valid playbook token — it will be left as literal text.`);
    } else if (!known.has(token)) {
      warnings.push(`Playbook "${token}" is not installed — "@${token}" will be left as literal text.`);
    }
  }
  return warnings;
}
