import { describe, it, expect } from 'vitest';
import { slugify, isValidSlug } from '../utils/slug.js';

describe('slugify', () => {
  it('converts a simple title to lowercase hyphen-separated slug', () => {
    expect(slugify('Build Auth System')).toBe('build-auth-system');
  });

  it('handles title with special characters', () => {
    expect(slugify('Fix bug #123: auth!')).toBe('fix-bug-123-auth');
  });

  it('collapses multiple spaces into single hyphens', () => {
    expect(slugify('too   many   spaces')).toBe('too-many-spaces');
  });

  it('removes leading and trailing hyphens', () => {
    expect(slugify('  leading and trailing  ')).toBe(
      'leading-and-trailing',
    );
  });

  it('collapses consecutive hyphens', () => {
    expect(slugify('a--b---c')).toBe('a-b-c');
  });

  it('handles single word', () => {
    expect(slugify('Test')).toBe('test');
  });

  it('handles already-slugified input', () => {
    expect(slugify('already-a-slug')).toBe('already-a-slug');
  });
});

describe('isValidSlug', () => {
  it('accepts valid slugs', () => {
    expect(isValidSlug('build-auth-system')).toBe(true);
    expect(isValidSlug('design-auth-schema')).toBe(true);
    expect(isValidSlug('test')).toBe(true);
    expect(isValidSlug('a1-b2-c3')).toBe(true);
  });

  it('rejects invalid slugs', () => {
    expect(isValidSlug('')).toBe(false);
    expect(isValidSlug('HAS-CAPS')).toBe(false);
    expect(isValidSlug('has spaces')).toBe(false);
    expect(isValidSlug('has_underscores')).toBe(false);
    expect(isValidSlug('-leading-hyphen')).toBe(false);
    expect(isValidSlug('trailing-hyphen-')).toBe(false);
    expect(isValidSlug('double--hyphen')).toBe(false);
  });

  it('rejects path traversal attempts', () => {
    expect(isValidSlug('../traversal')).toBe(false);
    expect(isValidSlug('has/slash')).toBe(false);
    expect(isValidSlug('../../etc')).toBe(false);
    expect(isValidSlug('foo.bar')).toBe(false);
  });
});
