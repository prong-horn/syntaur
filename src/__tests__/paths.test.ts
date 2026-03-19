import { describe, it, expect } from 'vitest';
import { homedir } from 'node:os';
import { expandHome, syntaurRoot, defaultMissionDir } from '../utils/paths.js';

describe('expandHome', () => {
  it('expands ~ to home directory', () => {
    const result = expandHome('~/test');
    expect(result).not.toContain('~');
    expect(result).toContain(homedir());
    expect(result.endsWith('/test') || result.endsWith('\\test')).toBe(true);
  });

  it('does not modify absolute paths', () => {
    expect(expandHome('/absolute/path')).toBe('/absolute/path');
  });

  it('does not modify relative paths without ~', () => {
    expect(expandHome('relative/path')).toBe('relative/path');
  });

  it('expands bare ~', () => {
    const result = expandHome('~');
    expect(result).toBe(homedir());
  });
});

describe('syntaurRoot', () => {
  it('returns absolute path ending with .syntaur', () => {
    const root = syntaurRoot();
    expect(root).not.toContain('~');
    expect(root.endsWith('.syntaur')).toBe(true);
  });
});

describe('defaultMissionDir', () => {
  it('returns absolute path ending with missions', () => {
    const dir = defaultMissionDir();
    expect(dir).not.toContain('~');
    expect(dir.endsWith('missions')).toBe(true);
    expect(dir).toContain('.syntaur');
  });
});
