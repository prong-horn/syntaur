// Platform-aware KeyboardEvent matcher.
// Pattern syntax: "Mod+k" ("Mod" = Meta on mac, Ctrl elsewhere), "Shift+t", "?", "[",
// "Enter", "g", "Escape". Uses event.key (not event.code) so non-US layouts work.
import { canonicalizeCombo } from '@shared/hotkeys-catalog';

export function isMac(): boolean {
  if (typeof navigator === 'undefined') return false;
  const platform = navigator.platform || '';
  const ua = navigator.userAgent || '';
  return /Mac|iPhone|iPad|iPod/.test(platform) || /Mac OS X/.test(ua);
}

interface ParsedPattern {
  key: string;
  mod: boolean;
  shift: boolean;
  alt: boolean;
  ctrl: boolean;
}

function parsePattern(pattern: string): ParsedPattern {
  const parts = pattern.split('+').map((p) => p.trim());
  const key = parts[parts.length - 1] ?? '';
  const mods = new Set(parts.slice(0, -1).map((m) => m.toLowerCase()));
  return {
    key: key.toLowerCase(),
    mod: mods.has('mod'),
    shift: mods.has('shift'),
    alt: mods.has('alt'),
    ctrl: mods.has('ctrl'),
  };
}

export function matchesPattern(event: KeyboardEvent, pattern: string): boolean {
  const p = parsePattern(pattern);
  const eventKey = event.key.toLowerCase();
  if (eventKey !== p.key) return false;

  const modActive = isMac() ? event.metaKey : event.ctrlKey;
  if (p.mod && !modActive) return false;
  if (!p.mod && !p.ctrl && modActive) return false;
  if (p.ctrl && !event.ctrlKey) return false;

  if (p.shift && !event.shiftKey) return false;
  if (!p.shift) {
    // Printable punctuation like "?" implies Shift on US layouts — allow it.
    const isPrintablePunctuation = p.key.length === 1 && !/^[a-z0-9]$/.test(p.key);
    if (!isPrintablePunctuation && event.shiftKey) return false;
  }

  if (p.alt && !event.altKey) return false;
  if (!p.alt && event.altKey) return false;

  return true;
}

/**
 * Inverse of formatPatternForDisplay: convert a live KeyboardEvent into a
 * canonical pattern string suitable for storage and conflict detection.
 *
 * Examples (mac):
 *   metaKey + shiftKey + key="K" -> "mod+shift+k"
 *   shiftKey + key="?"           -> "?"          (Shift folded into the punctuation)
 *   key="Enter"                  -> "enter"
 *   key="Escape"                 -> "escape"
 *   key="["                      -> "["
 */
export function patternFromKeyboardEvent(event: KeyboardEvent): string {
  const mods: string[] = [];
  const modActive = isMac() ? event.metaKey : event.ctrlKey;
  if (modActive) mods.push('mod');
  // Only emit ctrl independently when it's not folded into "mod" (mac uses
  // metaKey for mod, so ctrl can stand alone there).
  if (event.ctrlKey && !modActive) mods.push('ctrl');
  if (event.altKey) mods.push('alt');

  const rawKey = event.key;
  let key: string;
  if (rawKey === ' ' || rawKey === 'Spacebar') {
    key = 'space';
  } else if (rawKey.length === 1) {
    key = rawKey.toLowerCase();
  } else {
    key = rawKey.toLowerCase();
  }

  // Shift is folded into printable punctuation (e.g. "?" already implies Shift
  // on US layouts) — only emit it when the key is a letter/digit and not when
  // the keystroke produced a shifted glyph.
  const isPrintableLetterOrDigit = key.length === 1 && /^[a-z0-9]$/.test(key);
  if (event.shiftKey && isPrintableLetterOrDigit) {
    mods.push('shift');
  }

  const combo = [...mods, key].join('+');
  return canonicalizeCombo(combo);
}

export function formatPatternForDisplay(pattern: string): string {
  const parts = pattern.split('+');
  return parts
    .map((part) => {
      const lower = part.toLowerCase();
      if (lower === 'mod') return isMac() ? '\u2318' : 'Ctrl';
      if (lower === 'shift') return isMac() ? '\u21E7' : 'Shift';
      if (lower === 'alt') return isMac() ? '\u2325' : 'Alt';
      if (lower === 'ctrl') return isMac() ? '\u2303' : 'Ctrl';
      if (lower === 'enter') return '\u21B5';
      if (lower === 'escape') return 'Esc';
      if (lower === 'arrowup') return '\u2191';
      if (lower === 'arrowdown') return '\u2193';
      if (part.length === 1) return part.toUpperCase();
      return part;
    })
    .join(isMac() ? '' : '+');
}
