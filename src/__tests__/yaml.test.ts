import { describe, it, expect } from 'vitest';
import { escapeYamlString } from '../utils/yaml.js';

describe('escapeYamlString', () => {
  it('wraps a simple string in double quotes', () => {
    expect(escapeYamlString('hello')).toBe('"hello"');
  });

  it('escapes internal double quotes', () => {
    expect(escapeYamlString('say "hello"')).toBe('"say \\"hello\\""');
  });

  it('escapes backslashes', () => {
    expect(escapeYamlString('path\\to\\file')).toBe('"path\\\\to\\\\file"');
  });

  it('handles strings with colons', () => {
    expect(escapeYamlString('Fix: auth bug')).toBe('"Fix: auth bug"');
  });

  it('handles empty string', () => {
    expect(escapeYamlString('')).toBe('""');
  });

  it('rejects multiline input with newline', () => {
    expect(() => escapeYamlString('line1\nline2')).toThrow('single-line');
  });

  it('rejects multiline input with carriage return', () => {
    expect(() => escapeYamlString('line1\rline2')).toThrow('single-line');
  });
});
