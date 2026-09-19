import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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
    expect(canonicalizeCombo('  g  n  ')).toBe('g n');
  });
});

describe('isReservedCombo (Option A navigation)', () => {
  it('flags the fixed navigation chords', () => {
    for (const k of ['g', 'g n', 'g b', 'g s', 'g l', 'g ,', 'n']) {
      expect(isReservedCombo(k)).toBe(true);
    }
  });

  it('does not flag removed palette/page chords', () => {
    expect(isReservedCombo('mod+k')).toBe(false);
    expect(isReservedCombo('?')).toBe(false);
    expect(isReservedCombo('g t')).toBe(false);
    expect(isReservedCombo('j')).toBe(false);
  });
});

describe('BindableActionKind', () => {
  it('exposes all canonical kinds', () => {
    expect(BINDABLE_ACTION_KINDS).toEqual(['new-project', 'new-ticket']);
  });

  it('isBindableActionKind validates membership', () => {
    expect(isBindableActionKind('new-project')).toBe(true);
    expect(isBindableActionKind('new-frobnicator')).toBe(false);
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

  it('does not collide with Option A reserved navigation combos', () => {
    for (const kind of BINDABLE_ACTION_KINDS) {
      expect(isReservedCombo(DEFAULT_BINDABLE_HOTKEYS[kind])).toBe(false);
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

  it('isDefaultBinding reports custom vs default correctly', () => {
    expect(isDefaultBinding({}, 'new-ticket')).toBe(true);
    expect(isDefaultBinding({ 'new-ticket': 'mod+x' }, 'new-ticket')).toBe(false);
  });
});

describe('BUILTIN_RESERVED_COMBOS catalog completeness', () => {
  it('matches NavigationHotkeys registration', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'dashboard/src/components/navigation/NavigationHotkeys.tsx'),
      'utf8',
    );
    for (const combo of BUILTIN_RESERVED_COMBOS) {
      if (combo === 'g') {
        expect(source).toContain("key === 'g'");
        continue;
      }
      const suffix = combo.startsWith('g ') ? combo.slice(2) : combo;
      if (combo.startsWith('g ')) {
        expect(source).toMatch(new RegExp(`['\"]?${suffix === ',' ? ',' : suffix}['\"]?\\s*:\\s*['\"]\\/`));
      } else {
        expect(source).toContain(`key === '${suffix}'`);
      }
    }
  });
});
