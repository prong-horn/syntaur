import { describe, it, expect } from 'vitest';
import { NAVIGATION_KEYMAP, formatKeymapHints } from '../keymap.js';

describe('NAVIGATION_KEYMAP', () => {
  it('does not repeat the action-bar buttons (l/a/q)', () => {
    const keys = NAVIGATION_KEYMAP.map((e) => e.keys);
    expect(keys).not.toContain('l');
    expect(keys).not.toContain('a');
    expect(keys).not.toContain('q');
  });

  it('covers focus cycling, movement, scrolling, selection, and quit', () => {
    const keys = NAVIGATION_KEYMAP.map((e) => e.keys);
    expect(keys).toEqual(['Tab', '↑/↓ j/k', 'PgUp/PgDn', 'Enter', 'Esc']);
  });
});

describe('formatKeymapHints', () => {
  it('joins each entry as "<keys> <label>" separated by two spaces', () => {
    expect(formatKeymapHints([{ keys: 'Tab', label: 'Focus' }, { keys: 'Esc', label: 'Quit' }])).toBe('Tab Focus  Esc Quit');
  });

  it('defaults to the full navigation keymap', () => {
    expect(formatKeymapHints()).toBe(formatKeymapHints(NAVIGATION_KEYMAP));
  });
});
