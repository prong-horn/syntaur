// Re-export the shared catalog (single source of truth lives at
// src/utils/hotkeysCatalog.ts; resolved here via the `@shared/hotkeys-catalog`
// alias defined in dashboard/tsconfig.json + dashboard/vite.config.ts).
//
// Adds dashboard-only UI metadata: BUILTIN_HOTKEY_CATALOG layers `description`
// and `scope` strings on top of BUILTIN_RESERVED_COMBOS so the bind recorder
// can show "Mod+K → Open command palette" instead of just "reserved".
import {
  BINDABLE_ACTION_KINDS,
  BUILTIN_RESERVED_COMBOS,
  DEFAULT_BINDABLE_HOTKEYS,
  canonicalizeCombo,
  effectiveBindings,
  isBindableActionKind,
  isDefaultBinding,
  isReservedCombo,
  type BindableActionKind,
} from '@shared/hotkeys-catalog';

export {
  BINDABLE_ACTION_KINDS,
  BUILTIN_RESERVED_COMBOS,
  DEFAULT_BINDABLE_HOTKEYS,
  canonicalizeCombo,
  effectiveBindings,
  isBindableActionKind,
  isDefaultBinding,
  isReservedCombo,
  type BindableActionKind,
};

export interface BuiltinHotkeyEntry {
  combo: string;
  description: string;
  scope: string;
}

// Dashboard-only metadata layered on top of BUILTIN_RESERVED_COMBOS. Used by
// the bind recorder + settings UI to show what each reserved combo does.
//
// IMPORTANT: keep in sync with BUILTIN_RESERVED_COMBOS in
// src/utils/hotkeysCatalog.ts. The lint script
// scripts/check-hotkey-catalog.ts catches dashboard `useHotkey({ keys: ... })`
// values that are missing from BUILTIN_RESERVED_COMBOS.
export const BUILTIN_HOTKEY_CATALOG: readonly BuiltinHotkeyEntry[] = [
  { combo: 'mod+k',       description: 'Open command palette',          scope: 'global' },
  { combo: 'mod+shift+k', description: 'Open actions palette',          scope: 'global' },
  { combo: '?',           description: 'Show keyboard shortcuts',       scope: 'global' },
  { combo: 'escape',      description: 'Close dialog or cancel',        scope: 'global' },
  { combo: 'enter',       description: 'Activate selected item',        scope: 'global' },
  { combo: 'shift+t',     description: 'Toggle light/dark theme',       scope: 'global' },

  { combo: 'g',           description: 'Start navigation chord',        scope: 'global' },
  { combo: 'g o',         description: 'Go to Overview',                scope: 'global' },
  { combo: 'g m',         description: 'Go to Projects',                scope: 'global' },
  { combo: 'g a',         description: 'Go to Assignments',             scope: 'global' },
  { combo: 'g t',         description: 'Go to Todos',                   scope: 'global' },
  { combo: 'g s',         description: 'Go to Servers',                 scope: 'global' },
  { combo: 'g !',         description: 'Go to Attention',               scope: 'global' },
  { combo: 'g ,',         description: 'Go to Settings',                scope: 'global' },

  { combo: 'j',           description: 'Move selection down',           scope: 'list' },
  { combo: 'k',           description: 'Move selection up',             scope: 'list' },
  { combo: 'o',           description: 'Open selected item',            scope: 'list' },

  { combo: 'a',           description: 'New assignment in project',     scope: 'project' },
  { combo: 'e',           description: 'Edit project / assignment',     scope: 'project|assignment' },

  { combo: '/',           description: 'Focus search',                  scope: 'assignments-board' },
  { combo: 'r',           description: 'Refresh board',                 scope: 'assignments-board' },

  { combo: 'p',           description: 'Edit plan',                     scope: 'assignment' },
  { combo: 'h',           description: 'Append handoff',                scope: 'assignment' },
  { combo: 'd',           description: 'Append decision record',        scope: 'assignment' },
  { combo: 's',           description: 'Edit scratchpad',               scope: 'assignment' },
  { combo: '[',           description: 'Previous assignment',           scope: 'assignment' },
  { combo: ']',           description: 'Next assignment',               scope: 'assignment' },
];

export function lookupReservedCombo(combo: string): BuiltinHotkeyEntry | null {
  const c = canonicalizeCombo(combo);
  if (!c) return null;
  return BUILTIN_HOTKEY_CATALOG.find((entry) => entry.combo === c) ?? null;
}

/**
 * Human-readable label for a bindable action kind. Used by the cheatsheet
 * and the settings page when it can't resolve a live Action by id.
 */
export const BINDABLE_ACTION_LABELS: Record<BindableActionKind, string> = {
  'new-workspace': 'New Workspace',
  'new-project': 'New Project',
  'new-todo': 'New Todo',
  'new-assignment': 'New Assignment',
};

