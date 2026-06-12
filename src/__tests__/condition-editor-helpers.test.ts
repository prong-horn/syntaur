import { describe, it, expect } from 'vitest';
import {
  whenToBuilderModel,
  astToBuilderModel,
  builderModelToString,
  validateCondition,
  deriveFieldOptions,
  opsForKind,
} from '../../dashboard/src/components/condition-editor-helpers';
import { parseQuery } from '../utils/query/index.js';
import { buildDeriveRegistry, acceptFactDeclarations, normalizeFactDeclarations } from '../utils/fact-registry.js';

const baseRegistry = buildDeriveRegistry([]);

describe('astToBuilderModel / builderModelToString round-trips', () => {
  it('a flat AND of comparisons', () => {
    const when = 'planApproved:true AND implementationStarted:true';
    const model = whenToBuilderModel(when);
    expect(model).not.toBeNull();
    expect(builderModelToString(model!)).toBe(when);
  });

  it('a single comparison', () => {
    const model = whenToBuilderModel('reviewRequested:true');
    expect(model).not.toBeNull();
    expect(builderModelToString(model!)).toBe('reviewRequested:true');
  });

  it('a numeric comparison operator', () => {
    const model = whenToBuilderModel('acRealTotal > 0');
    expect(model).not.toBeNull();
    expect(model!.groups[0].comparisons[0]).toMatchObject({ field: 'acRealTotal', op: '>', value: '0' });
    expect(builderModelToString(model!)).toBe('acRealTotal > 0');
  });

  it('a flat OR of comparisons', () => {
    const when = 'acAllChecked:true OR reviewRequested:true';
    const model = whenToBuilderModel(when);
    expect(model).not.toBeNull();
    expect(model!.outerJoin).toBe('OR');
    expect(builderModelToString(model!)).toBe(when);
  });

  it('an OR of AND-groups (one nesting level) parenthesizes multi-comparison groups', () => {
    const when = '(planApproved:true AND implementationStarted:true) OR reviewRequested:true';
    const model = whenToBuilderModel(when);
    expect(model).not.toBeNull();
    expect(model!.outerJoin).toBe('OR');
    expect(model!.groups).toHaveLength(2);
    expect(builderModelToString(model!)).toBe(when);
  });
});

describe('astToBuilderModel returns null for grammar beyond the builder', () => {
  it('NOT', () => {
    const ast = parseQuery('NOT planApproved:true').ast!;
    expect(astToBuilderModel(ast)).toBeNull();
  });

  it('the `*` catch-all', () => {
    const ast = parseQuery('*').ast!;
    expect(astToBuilderModel(ast)).toBeNull();
  });

  it('an IN-list', () => {
    const ast = parseQuery('status:(pending, in_progress)').ast!;
    expect(astToBuilderModel(ast)).toBeNull();
  });

  it('whenToBuilderModel returns null for empty / star', () => {
    expect(whenToBuilderModel('')).toBeNull();
    expect(whenToBuilderModel('*')).toBeNull();
  });
});

describe('validateCondition', () => {
  it('accepts a valid built-in condition', () => {
    expect(validateCondition('planApproved:true', baseRegistry)).toBeNull();
  });

  it('treats `*` as valid (caller-handled)', () => {
    expect(validateCondition('*', baseRegistry)).toBeNull();
  });

  it('rejects an unknown field', () => {
    expect(validateCondition('bogusField:true', baseRegistry)).not.toBeNull();
  });

  it('accepts a declared custom fact in its registry', () => {
    const accepted = acceptFactDeclarations(normalizeFactDeclarations([{ name: 'shipped', type: 'bool', binds: null }]));
    const registry = buildDeriveRegistry(accepted);
    expect(validateCondition('shipped:true', registry)).toBeNull();
    expect(validateCondition('shipped:true', baseRegistry)).not.toBeNull();
  });
});

describe('deriveFieldOptions / opsForKind', () => {
  it('exposes the built-in derive fields as camelCase with kinds', () => {
    const opts = deriveFieldOptions([]);
    const byName = new Map(opts.map((o) => [o.name, o.kind]));
    expect(byName.get('planApproved')).toBe('bool');
    expect(byName.get('acRealTotal')).toBe('number');
    // timestamp/identity fields are NOT in the derive vocabulary
    expect(byName.has('created')).toBe(false);
  });

  it('includes accepted custom facts', () => {
    const accepted = acceptFactDeclarations(normalizeFactDeclarations([{ name: 'shipped', type: 'bool', binds: null }]));
    const names = deriveFieldOptions(accepted).map((o) => o.name);
    expect(names).toContain('shipped');
  });

  it('bool fields offer only `:`; number fields offer comparisons', () => {
    expect(opsForKind('bool')).toEqual([':']);
    expect(opsForKind('number')).toContain('>');
  });
});
