import { describe, it, expect } from 'vitest';
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
} from '../utils/hotkeysCatalog.js';

describe('canonicalizeCombo', () => {
  it('lowercases and reorders modifiers', () => {
    expect(canonicalizeCombo('Shift+Mod+K')).toBe('mod+shift+k');
    expect(canonicalizeCombo('Alt+Shift+Mod+K')).toBe('mod+alt+shift+k');
    expect(canonicalizeCombo('Ctrl+Shift+a')).toBe('ctrl+shift+a');
  });

  it('preserves single-key forms', () => {
    expect(canonicalizeCombo('?')).toBe('?');
    expect(canonicalizeCombo('Enter')).toBe('enter');
    expect(canonicalizeCombo('Escape')).toBe('escape');
    expect(canonicalizeCombo('[')).toBe('[');
  });

  it('canonicalizes chord-form (space-separated) combos', () => {
    expect(canonicalizeCombo('g A')).toBe('g a');
    expect(canonicalizeCombo('  g  o  ')).toBe('g o');
  });

  it('returns "" for empty input', () => {
    expect(canonicalizeCombo('')).toBe('');
    expect(canonicalizeCombo('   ')).toBe('');
  });

  it('strips redundant whitespace and duplicate modifiers', () => {
    expect(canonicalizeCombo(' Mod + Mod + K ')).toBe('mod+k');
  });
});

describe('isReservedCombo', () => {
  it('flags built-in combos in any case', () => {
    expect(isReservedCombo('Mod+K')).toBe(true);
    expect(isReservedCombo('mod+shift+k')).toBe(true);
    expect(isReservedCombo('?')).toBe(true);
    expect(isReservedCombo('shift+t')).toBe(true);
    expect(isReservedCombo('g a')).toBe(true);
    expect(isReservedCombo('  ['  )).toBe(true);
  });

  it('does NOT flag user-friendly combos', () => {
    expect(isReservedCombo('Mod+Shift+T')).toBe(false);
    expect(isReservedCombo('Alt+x')).toBe(false);
    expect(isReservedCombo('shift+n')).toBe(false);
  });

  it('returns false for empty input', () => {
    expect(isReservedCombo('')).toBe(false);
  });
});

describe('BindableActionKind', () => {
  it('exposes all four canonical kinds', () => {
    expect(BINDABLE_ACTION_KINDS).toEqual([
      'new-workspace',
      'new-project',
      'new-todo',
      'new-assignment',
    ]);
  });

  it('isBindableActionKind validates membership', () => {
    expect(isBindableActionKind('new-workspace')).toBe(true);
    expect(isBindableActionKind('new-frobnicator')).toBe(false);
    expect(isBindableActionKind(42)).toBe(false);
    expect(isBindableActionKind(null)).toBe(false);
  });
});

describe('DEFAULT_BINDABLE_HOTKEYS', () => {
  it('provides a default for every bindable action kind', () => {
    for (const kind of BINDABLE_ACTION_KINDS) {
      const combo = DEFAULT_BINDABLE_HOTKEYS[kind];
      expect(typeof combo).toBe('string');
      expect(combo.length).toBeGreaterThan(0);
    }
  });

  it('uses canonicalized combos', () => {
    for (const kind of BINDABLE_ACTION_KINDS) {
      const combo = DEFAULT_BINDABLE_HOTKEYS[kind];
      expect(canonicalizeCombo(combo)).toBe(combo);
    }
  });

  it('does not collide with any reserved built-in combo', () => {
    for (const kind of BINDABLE_ACTION_KINDS) {
      expect(isReservedCombo(DEFAULT_BINDABLE_HOTKEYS[kind])).toBe(false);
    }
  });

  it('uses unique combos across all kinds', () => {
    const seen = new Set<string>();
    for (const kind of BINDABLE_ACTION_KINDS) {
      const combo = DEFAULT_BINDABLE_HOTKEYS[kind];
      expect(seen.has(combo)).toBe(false);
      seen.add(combo);
    }
  });
});

describe('effectiveBindings', () => {
  it('returns defaults when there are no custom overrides', () => {
    const out = effectiveBindings({});
    for (const kind of BINDABLE_ACTION_KINDS) {
      expect(out[kind]).toBe(DEFAULT_BINDABLE_HOTKEYS[kind]);
    }
  });

  it('overlays custom bindings on top of defaults', () => {
    const custom: Partial<Record<BindableActionKind, string>> = {
      'new-todo': 'mod+x',
    };
    const out = effectiveBindings(custom);
    expect(out['new-todo']).toBe('mod+x');
    expect(out['new-project']).toBe(DEFAULT_BINDABLE_HOTKEYS['new-project']);
  });

  it('isDefaultBinding reports custom vs default correctly', () => {
    expect(isDefaultBinding({}, 'new-todo')).toBe(true);
    expect(
      isDefaultBinding({ 'new-todo': 'mod+x' }, 'new-todo'),
    ).toBe(false);
    expect(isDefaultBinding({ 'new-todo': '' }, 'new-todo')).toBe(true);
  });
});

describe('BUILTIN_RESERVED_COMBOS catalog completeness', () => {
  it('includes all assignment-detail page shortcuts', () => {
    for (const k of ['p', 'h', 'd', 's', '[', ']', 'e']) {
      expect(BUILTIN_RESERVED_COMBOS.includes(k)).toBe(true);
    }
  });

  it('includes all g-chord prefixes', () => {
    for (const k of ['g', 'g o', 'g m', 'g a', 'g t', 'g s', 'g !', 'g ,']) {
      expect(BUILTIN_RESERVED_COMBOS.includes(k)).toBe(true);
    }
  });

  it('includes the global modifier combos', () => {
    for (const k of ['mod+k', 'mod+shift+k', 'shift+t', '?', 'escape', 'enter']) {
      expect(BUILTIN_RESERVED_COMBOS.includes(k)).toBe(true);
    }
  });
});
