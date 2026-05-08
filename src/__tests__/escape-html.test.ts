import { describe, it, expect } from 'vitest';
import { escapeHtml } from '../utils/escape-html.js';

describe('escapeHtml', () => {
  it('escapes the five special characters', () => {
    expect(escapeHtml('& < > " \'')).toBe('&amp; &lt; &gt; &quot; &#39;');
  });

  it('passes unicode through untouched', () => {
    expect(escapeHtml('héllo 🚀 ñ')).toBe('héllo 🚀 ñ');
  });

  it('returns "" for empty / null / undefined', () => {
    expect(escapeHtml('')).toBe('');
    expect(escapeHtml(null)).toBe('');
    expect(escapeHtml(undefined)).toBe('');
  });

  it('coerces non-string defensively', () => {
    expect(escapeHtml(42 as unknown as string)).toBe('42');
    expect(escapeHtml(true as unknown as string)).toBe('true');
  });

  it('escapes ampersand first to avoid double-encoding', () => {
    expect(escapeHtml('&lt;')).toBe('&amp;lt;');
  });
});
