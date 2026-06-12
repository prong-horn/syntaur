import { describe, it, expect } from 'vitest';
import {
  toEditableDerive,
  fromEditableDerive,
  catchAllIndex,
  validateDeriveSection,
} from '../../dashboard/src/pages/derive-rules-helpers';
import { DEFAULT_DERIVE_CONFIG } from '../utils/derive-config.js';
import { buildDeriveRegistry } from '../utils/fact-registry.js';

const statuses = DEFAULT_DERIVE_CONFIG.phaseLadder
  .map((r) => ({ id: r.phase }))
  .concat([{ id: 'parked' }, { id: 'blocked' }]);

describe('toEditableDerive / fromEditableDerive', () => {
  it('round-trips the default derive config (ignoring row keys)', () => {
    const editable = toEditableDerive(DEFAULT_DERIVE_CONFIG);
    const back = fromEditableDerive(editable);
    expect(back).toEqual(DEFAULT_DERIVE_CONFIG);
  });

  it('assigns a unique row key per rung and disposition rule', () => {
    const editable = toEditableDerive(DEFAULT_DERIVE_CONFIG);
    const keys = [
      ...editable.phaseLadder.map((r) => r.rowKey),
      ...editable.disposition.map((r) => r.rowKey),
    ];
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('restores the fixed headline terminal/active fields', () => {
    const editable = toEditableDerive(DEFAULT_DERIVE_CONFIG);
    const back = fromEditableDerive(editable);
    expect(back.headline.terminal).toBe('passthrough');
    expect(back.headline.active).toBe('phase');
  });

  it('drops an empty `next` label', () => {
    const editable = toEditableDerive(DEFAULT_DERIVE_CONFIG);
    editable.phaseLadder[1].next = '';
    const back = fromEditableDerive(editable);
    expect('next' in back.phaseLadder[1]).toBe(false);
  });
});

describe('catchAllIndex', () => {
  it('finds the `*` rung at index 0 of the defaults', () => {
    const editable = toEditableDerive(DEFAULT_DERIVE_CONFIG);
    expect(catchAllIndex(editable.phaseLadder)).toBe(0);
  });

  it('returns -1 when no catch-all is present', () => {
    const editable = toEditableDerive(DEFAULT_DERIVE_CONFIG);
    const without = editable.phaseLadder.filter((r) => r.when !== '*');
    expect(catchAllIndex(without)).toBe(-1);
  });
});

describe('validateDeriveSection', () => {
  const registry = buildDeriveRegistry([]);

  it('reports no problems for the default config against its statuses', () => {
    expect(validateDeriveSection(DEFAULT_DERIVE_CONFIG, statuses, registry)).toEqual([]);
  });

  it('flags a rung referencing an undefined status', () => {
    const bad = {
      ...DEFAULT_DERIVE_CONFIG,
      phaseLadder: [...DEFAULT_DERIVE_CONFIG.phaseLadder, { phase: 'ghost', when: 'planApproved:true' }],
    };
    const problems = validateDeriveSection(bad, statuses, registry);
    expect(problems.some((p) => p.includes('ghost'))).toBe(true);
  });

  it('flags a missing else-arm', () => {
    const bad = {
      ...DEFAULT_DERIVE_CONFIG,
      disposition: DEFAULT_DERIVE_CONFIG.disposition.filter((r) => r.when !== null),
    };
    const problems = validateDeriveSection(bad, statuses, registry);
    expect(problems.some((p) => p.includes('else'))).toBe(true);
  });

  it('flags an unparseable condition', () => {
    const bad = {
      ...DEFAULT_DERIVE_CONFIG,
      phaseLadder: [{ phase: 'draft', when: '*' }, { phase: 'review', when: 'bogusField:true' }],
    };
    const problems = validateDeriveSection(bad, statuses, registry);
    expect(problems.some((p) => p.toLowerCase().includes('invalid condition'))).toBe(true);
  });
});
