import { describe, it, expect } from 'vitest';
import {
  validateFactsForSave,
  buildFactsSavePayload,
  flagInvalidRows,
  computeRemovedFactNames,
} from '../../dashboard/src/pages/facts-section-helpers';
import type { RawFactDeclaration } from '../utils/fact-registry.js';

describe('validateFactsForSave', () => {
  it('flags empty name', () => {
    const problems = validateFactsForSave([{ name: '', type: 'bool', binds: null }]);
    expect(problems.length).toBeGreaterThan(0);
    expect(problems[0]).toMatch(/invalid name/);
  });

  it('flags duplicate names', () => {
    const problems = validateFactsForSave([
      { name: 'x', type: 'bool', binds: null },
      { name: 'x', type: 'number', binds: null },
    ]);
    expect(problems.length).toBeGreaterThan(0);
    expect(problems[0]).toMatch(/duplicate/);
  });

  it('flags built-in collision', () => {
    const problems = validateFactsForSave([{ name: 'blocked', type: 'bool', binds: null }]);
    expect(problems.length).toBeGreaterThan(0);
    expect(problems[0]).toMatch(/collides with a built-in/);
  });

  it('passes for valid facts', () => {
    const problems = validateFactsForSave([
      { name: 'customBool', type: 'bool', binds: null },
      { name: 'customNum', type: 'number', binds: null },
      { name: 'customAttest', type: 'attestation', binds: 'commit' },
    ]);
    expect(problems).toEqual([]);
  });
});

describe('buildFactsSavePayload', () => {
  it('returns only facts when no acks', () => {
    const rows: RawFactDeclaration[] = [{ name: 'x', type: 'bool', binds: null }];
    const payload = buildFactsSavePayload(rows);
    expect(payload).toEqual({ facts: rows });
  });

  it('includes factRemovalAcks when provided', () => {
    const rows: RawFactDeclaration[] = [{ name: 'x', type: 'bool', binds: null }];
    const payload = buildFactsSavePayload(rows, ['x']);
    expect(payload).toEqual({ facts: rows, factRemovalAcks: ['x'] });
  });

  it('omits empty acks array', () => {
    const rows: RawFactDeclaration[] = [{ name: 'x', type: 'bool', binds: null }];
    const payload = buildFactsSavePayload(rows, []);
    expect(payload).toEqual({ facts: rows });
  });
});

describe('flagInvalidRows', () => {
  it('flags invalid name at correct index', () => {
    const rows: RawFactDeclaration[] = [
      { name: 'ok', type: 'bool', binds: null },
      { name: 'Bad-Name', type: 'bool', binds: null },
    ];
    const map = flagInvalidRows(rows);
    expect(map.has(0)).toBe(false);
    expect(map.has(1)).toBe(true);
    expect(map.get(1)).toMatch(/invalid name/);
  });

  it('flags duplicate at the second occurrence', () => {
    const rows: RawFactDeclaration[] = [
      { name: 'x', type: 'bool', binds: null },
      { name: 'x', type: 'number', binds: null },
    ];
    const map = flagInvalidRows(rows);
    expect(map.has(0)).toBe(false);
    expect(map.has(1)).toBe(true);
    expect(map.get(1)).toMatch(/duplicate/);
  });

  it('flags built-in collision', () => {
    const rows: RawFactDeclaration[] = [
      { name: 'blocked', type: 'bool', binds: null },
    ];
    const map = flagInvalidRows(rows);
    expect(map.has(0)).toBe(true);
    expect(map.get(0)).toMatch(/collides with a built-in/);
  });

  it('handles empty rows', () => {
    const map = flagInvalidRows([]);
    expect(map.size).toBe(0);
  });
});

describe('computeRemovedFactNames', () => {
  it('returns names present in saved but not in current', () => {
    const saved: RawFactDeclaration[] = [
      { name: 'a', type: 'bool', binds: null },
      { name: 'b', type: 'bool', binds: null },
    ];
    const current: RawFactDeclaration[] = [
      { name: 'a', type: 'bool', binds: null },
    ];
    expect(computeRemovedFactNames(saved, current)).toEqual(['b']);
  });

  it('returns empty array when nothing removed', () => {
    const saved: RawFactDeclaration[] = [{ name: 'a', type: 'bool', binds: null }];
    const current: RawFactDeclaration[] = [{ name: 'a', type: 'bool', binds: null }];
    expect(computeRemovedFactNames(saved, current)).toEqual([]);
  });
});
