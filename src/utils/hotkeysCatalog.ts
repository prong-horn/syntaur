// Shared hotkey catalog: bindable action kinds, reserved combos, and the
// canonical combo string format. Imported directly by the Express server
// (src/dashboard/server.ts) and by the dashboard via the
// `@shared/hotkeys-catalog` alias defined in dashboard/tsconfig.json +
// dashboard/vite.config.ts.

export type BindableActionKind =
  | 'new-project'
  | 'new-ticket';

export const BINDABLE_ACTION_KINDS: readonly BindableActionKind[] = [
  'new-project',
  'new-ticket',
];

export function isBindableActionKind(value: unknown): value is BindableActionKind {
  return (
    typeof value === 'string' &&
    (BINDABLE_ACTION_KINDS as readonly string[]).includes(value)
  );
}

// Reserved combos for SV-12 Option A navigation hotkeys. The dashboard no longer
// registers palette/custom bindings; historical config blocks remain on disk.
export const BUILTIN_RESERVED_COMBOS: readonly string[] = [
  'g',
  'g n',
  'g b',
  'g s',
  'g l',
  'g ,',
  'n',
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

/**
 * Legacy default bindings retained for config backward compatibility only.
 * The dashboard no longer registers these combos after SV-12 Option A.
 */
export const DEFAULT_BINDABLE_HOTKEYS: Readonly<Record<BindableActionKind, string>> = {
  'new-project': canonicalizeCombo('Mod+Shift+Alt+p'),
  'new-ticket': canonicalizeCombo('Mod+Shift+Alt+t'),
};

/**
 * Returns the effective binding map: defaults underneath, user customs on top.
 * A user-bound combo always wins; if the user has no entry for a kind, the
 * default is returned (if any).
 */
export function effectiveBindings(
  custom: Partial<Record<BindableActionKind, string>>,
): Partial<Record<BindableActionKind, string>> {
  const out: Partial<Record<BindableActionKind, string>> = {
    ...DEFAULT_BINDABLE_HOTKEYS,
  };
  for (const kind of BINDABLE_ACTION_KINDS) {
    const override = custom[kind];
    if (typeof override === 'string' && override.length > 0) {
      out[kind] = override;
    }
  }
  return out;
}

/** True when the given kind currently uses its default combo (no user override). */
export function isDefaultBinding(
  custom: Partial<Record<BindableActionKind, string>>,
  kind: BindableActionKind,
): boolean {
  const override = custom[kind];
  return typeof override !== 'string' || override.length === 0;
}
