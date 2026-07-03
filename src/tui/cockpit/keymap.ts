export interface KeymapEntry {
  /** Display form of the binding, e.g. `Tab`, `↑/↓ j/k`, `PgUp/PgDn`. */
  keys: string;
  /** What it does, e.g. `Focus`, `Move`, `Scroll`. */
  label: string;
}

/**
 * Canonical keyboard-parity table for pane navigation — the single source
 * both Cockpit's `useInput` handlers implement against and the action-bar
 * hint row renders from, so the two can never drift (design spec §5.5).
 * Launch/Attach/Quit (`l`/`a`/`q`) are already visible as action-bar buttons
 * (see `actionBarLayout.ts`) and are intentionally NOT repeated here — these
 * are the bindings with no other on-screen affordance.
 */
export const NAVIGATION_KEYMAP: readonly KeymapEntry[] = [
  { keys: 'Tab', label: 'Focus' },
  { keys: '↑/↓ j/k', label: 'Move' },
  { keys: 'PgUp/PgDn', label: 'Scroll' },
  { keys: 'Enter', label: 'Select' },
  { keys: 'Esc', label: 'Quit' },
];

/** Renders the navigation keymap as a single dim hint string, e.g. `Tab Focus  ↑/↓ j/k Move  ...`. */
export function formatKeymapHints(entries: readonly KeymapEntry[] = NAVIGATION_KEYMAP): string {
  return entries.map((e) => `${e.keys} ${e.label}`).join('  ');
}
