import { describe, it, expect } from 'vitest';
import {
  DEFAULT_SEARCH_CONFIG,
  ENTITY_KINDS,
  SEARCH_FIELD_NAMES,
  isValidDefaultScope,
  normalizeSearchConfig,
  validateAliases,
} from '../utils/search-schema.js';

describe('search-schema', () => {
  describe('SEARCH_FIELD_NAMES', () => {
    it('covers every palette field-name the aliases must not shadow', () => {
      // Mirrors the keys of PALETTE_FIELDS in dashboard/src/hotkeys/paletteQuery.ts.
      for (const f of [
        'kind',
        'status',
        'tag',
        'tags',
        'assignee',
        'type',
        'project',
        'externalid',
        'jira',
        'title',
        'search',
      ]) {
        expect(SEARCH_FIELD_NAMES).toContain(f);
      }
    });
  });

  describe('isValidDefaultScope', () => {
    it('accepts all + every entity kind', () => {
      expect(isValidDefaultScope('all')).toBe(true);
      for (const kind of ENTITY_KINDS) expect(isValidDefaultScope(kind)).toBe(true);
    });

    it('rejects junk', () => {
      expect(isValidDefaultScope('everything')).toBe(false);
      expect(isValidDefaultScope('')).toBe(false);
      expect(isValidDefaultScope(42)).toBe(false);
      expect(isValidDefaultScope(null)).toBe(false);
    });
  });

  describe('normalizeSearchConfig', () => {
    it('returns a full default for non-object input', () => {
      expect(normalizeSearchConfig(undefined)).toEqual(DEFAULT_SEARCH_CONFIG);
      expect(normalizeSearchConfig(null)).toEqual(DEFAULT_SEARCH_CONFIG);
      expect(normalizeSearchConfig('nope')).toEqual(DEFAULT_SEARCH_CONFIG);
    });

    it('coerces an invalid defaultScope to all', () => {
      expect(normalizeSearchConfig({ defaultScope: 'bogus' }).defaultScope).toBe('all');
      expect(normalizeSearchConfig({ defaultScope: 'project' }).defaultScope).toBe('project');
    });

    it('defaults externalIds to true and respects an explicit boolean', () => {
      expect(normalizeSearchConfig({}).externalIds).toBe(true);
      expect(normalizeSearchConfig({ externalIds: false }).externalIds).toBe(false);
      expect(normalizeSearchConfig({ externalIds: 'false' }).externalIds).toBe(true); // non-boolean → default
    });

    it('falls back to default aliases when the key is absent', () => {
      expect(normalizeSearchConfig({ defaultScope: 'all' }).aliases).toEqual(
        DEFAULT_SEARCH_CONFIG.aliases,
      );
    });

    it('keeps an explicitly empty aliases map empty', () => {
      expect(normalizeSearchConfig({ aliases: {} }).aliases).toEqual({});
    });

    it('drops invalid alias entries (bad key, collision, reserved, non-kind value)', () => {
      const result = normalizeSearchConfig({
        aliases: {
          x: 'assignment', // ok
          A: 'project', // bad key shape (uppercase)
          status: 'todo', // collides with a field name
          all: 'server', // reserved
          y: 'notakind', // bad value
          '2bad': 'todo', // must start with a letter
        },
      });
      expect(result.aliases).toEqual({ x: 'assignment' });
    });
  });

  describe('validateAliases', () => {
    it('accepts a valid map', () => {
      expect(validateAliases({ a: 'assignment', pb: 'playbook' })).toEqual({ ok: true });
    });

    it('accepts an empty map', () => {
      expect(validateAliases({})).toEqual({ ok: true });
    });

    it('rejects a non-object', () => {
      const r = validateAliases('nope');
      expect(r.ok).toBe(false);
    });

    it('rejects a bad key shape', () => {
      const r = validateAliases({ Foo: 'assignment' });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.errors.join(' ')).toMatch(/lowercase/);
    });

    it('rejects the reserved "all" key', () => {
      const r = validateAliases({ all: 'assignment' });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.errors.join(' ')).toMatch(/reserved/);
    });

    it('rejects a collision with a field name', () => {
      const r = validateAliases({ status: 'assignment' });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.errors.join(' ')).toMatch(/collides/);
    });

    it('rejects a value that is not an entity kind', () => {
      const r = validateAliases({ x: 'widget' });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.errors.join(' ')).toMatch(/must map to one of/);
    });
  });
});
