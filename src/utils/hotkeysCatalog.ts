// Shared hotkey catalog: bindable action kinds, reserved combos, and the
// canonical combo string format. Imported directly by the Express server
// (src/dashboard/server.ts) and by the dashboard via the
// `@shared/hotkeys-catalog` alias defined in dashboard/tsconfig.json +
// dashboard/vite.config.ts.

export type BindableActionKind =
  | 'new-workspace'
  | 'new-project'
  | 'new-todo'
  | 'new-assignment';

export const BINDABLE_ACTION_KINDS: readonly BindableActionKind[] = [
  'new-workspace',
  'new-project',
  'new-todo',
  'new-assignment',
];

export function isBindableActionKind(value: unknown): value is BindableActionKind {
  return (
    typeof value === 'string' &&
    (BINDABLE_ACTION_KINDS as readonly string[]).includes(value)
  );
}

// Reserved combos that user-bound hotkeys may NOT shadow. Hand-maintained;
// scripts/check-hotkey-catalog.ts greps `useHotkey({` across the dashboard and
// fails if it sees a `keys` value that is not represented here.
//
// Combos are stored in canonical form (see canonicalizeCombo). The list
// includes:
//   - global UI combos (Mod+k, Mod+Shift+k, ?, Escape, Enter, Shift+t)
//   - g <suffix> chord prefixes (the lone "g" is reserved as a chord starter)
//   - list-scope letters
//   - page-scoped shortcuts that exist when those pages are mounted
export const BUILTIN_RESERVED_COMBOS: readonly string[] = [
  'mod+k',
  'mod+shift+k',
  '?',
  'escape',
  'enter',
  'shift+t',
  // g-chord starter + suffixes
  'g',
  'g o',
  'g m',
  'g a',
  'g t',
  'g s',
  'g !',
  'g ,',
  // list-scope navigation
  'j',
  'k',
  'o',
  // ProjectDetail page
  'a',
  'e',
  // AssignmentsPage board
  '/',
  'r',
  // AssignmentDetail page
  'p',
  'h',
  'd',
  's',
  '[',
  ']',
];

const MODIFIER_ORDER: readonly string[] = ['mod', 'ctrl', 'alt', 'shift'];

/**
 * Canonicalize a combo string for storage and comparison.
 *
 * - Trims whitespace.
 * - Splits on `+` for single-key combos; preserves space-separated chord form
 *   (e.g. `g a`) by canonicalizing each part independently.
 * - Lowercases everything (modifiers and the trailing key alike).
 * - Reorders modifiers into canonical order: mod, ctrl, alt, shift.
 *
 * Examples:
 *   canonicalizeCombo("Shift+Mod+K")  -> "mod+shift+k"
 *   canonicalizeCombo(" cmd + Enter") -> "mod+enter"  (after caller maps cmd->mod)
 *   canonicalizeCombo("g A")          -> "g a"
 *   canonicalizeCombo("?")            -> "?"
 */
export function canonicalizeCombo(input: string): string {
  if (typeof input !== 'string') return '';
  const trimmed = input.trim();
  if (!trimmed) return '';

  // Chord form: space-separated, no `+` separators (e.g. "g a"). When the
  // input contains `+` it's treated as a single combo even if it has stray
  // whitespace around the separators (e.g. "Mod + K").
  if (/\s/.test(trimmed) && !trimmed.includes('+')) {
    return trimmed
      .split(/\s+/)
      .map(canonicalizeCombo)
      .filter((part) => part.length > 0)
      .join(' ');
  }

  const parts = trimmed.split('+').map((p) => p.trim()).filter((p) => p.length > 0);
  if (parts.length === 0) return '';
  if (parts.length === 1) {
    return parts[0].toLowerCase();
  }

  const key = parts[parts.length - 1].toLowerCase();
  const mods = parts.slice(0, -1).map((m) => m.toLowerCase());

  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const m of MODIFIER_ORDER) {
    if (mods.includes(m) && !seen.has(m)) {
      ordered.push(m);
      seen.add(m);
    }
  }
  // Append any non-standard modifiers at the end (preserves user intent for
  // anything we don't recognize).
  for (const m of mods) {
    if (!seen.has(m)) {
      ordered.push(m);
      seen.add(m);
    }
  }

  return [...ordered, key].join('+');
}

/**
 * Returns true when `combo` (canonicalized) collides with a built-in reserved
 * combo. Server-side enforcement entry point.
 */
export function isReservedCombo(combo: string): boolean {
  const c = canonicalizeCombo(combo);
  if (!c) return false;
  return (BUILTIN_RESERVED_COMBOS as readonly string[]).includes(c);
}
