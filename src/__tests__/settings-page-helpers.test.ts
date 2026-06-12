import { describe, it, expect } from 'vitest';
import {
  buildStatusSavePayload,
  pruneStaleResolutions,
  sortStatusesByOrder,
  findStatusRuleReferences,
  headlineReferencesStatus,
  remapStatusInDerive,
  remapStatusInTransitions,
  dropStatusFromDerive,
  dropStatusFromTransitions,
} from '../../dashboard/src/pages/settings-page-helpers';
import type { StatusResolution } from '../../dashboard/src/hooks/useStatusConfig';
import { toEditableDerive } from '../../dashboard/src/pages/derive-rules-helpers';
import { toEditableTransitions } from '../../dashboard/src/pages/transitions-helpers';
import { DEFAULT_DERIVE_CONFIG } from '../utils/derive-config.js';

const baseStatuses = [
  { id: 'pending', label: 'Pending' },
  { id: 'in_progress', label: 'In Progress' },
];

describe('buildStatusSavePayload', () => {
  it('cancel scenario: no resolutions buffered → empty resolutions array', () => {
    const result = buildStatusSavePayload({
      statuses: baseStatuses,
      order: ['pending', 'in_progress'],
      pendingResolutions: new Map(),
    });
    expect(result.resolutions).toEqual([]);
    expect(result.body.resolutions).toEqual([]);
    expect(result.body.statuses.map((s) => s.id)).toEqual(['pending', 'in_progress']);
  });

  it('confirm-remap scenario: pending → in_progress resolution makes it into body', () => {
    const resolutions = new Map<string, StatusResolution>([
      ['pending', { id: 'pending', mode: 'remap', target: 'in_progress' }],
    ]);
    const result = buildStatusSavePayload({
      statuses: [{ id: 'in_progress', label: 'In Progress' }],
      order: ['in_progress'],
      pendingResolutions: resolutions,
    });
    expect(result.resolutions).toEqual([{ id: 'pending', mode: 'remap', target: 'in_progress' }]);
    expect(result.body.statuses.map((s) => s.id)).toEqual(['in_progress']);
  });

  it('confirm-delete scenario: delete resolution makes it into body', () => {
    const resolutions = new Map<string, StatusResolution>([
      ['pending', { id: 'pending', mode: 'delete' }],
    ]);
    const result = buildStatusSavePayload({
      statuses: [{ id: 'in_progress', label: 'In Progress' }],
      order: ['in_progress'],
      pendingResolutions: resolutions,
    });
    expect(result.resolutions).toEqual([{ id: 'pending', mode: 'delete' }]);
  });

  it('preserves optional status fields (description, color, terminal)', () => {
    const result = buildStatusSavePayload({
      statuses: [
        {
          id: 'completed',
          label: 'Completed',
          description: 'Done',
          color: '#10b981',
          terminal: true,
        },
      ],
      order: ['completed'],
      pendingResolutions: new Map(),
    });
    expect(result.body.statuses[0]).toEqual({
      id: 'completed',
      label: 'Completed',
      description: 'Done',
      color: '#10b981',
      terminal: true,
    });
  });

  it('omits empty optional fields', () => {
    const result = buildStatusSavePayload({
      statuses: [{ id: 'minimal', label: 'Minimal', description: '', color: '', terminal: false }],
      order: ['minimal'],
      pendingResolutions: new Map(),
    });
    expect(result.body.statuses[0]).toEqual({ id: 'minimal', label: 'Minimal' });
  });

  it('no-wipe: omits transitions entirely when none provided (no transitions: [])', () => {
    const result = buildStatusSavePayload({
      statuses: baseStatuses,
      order: ['pending', 'in_progress'],
      pendingResolutions: new Map(),
    });
    expect('transitions' in result.body).toBe(false);
  });

  it('includes derive/transitions/facts when provided', () => {
    const result = buildStatusSavePayload({
      statuses: baseStatuses,
      order: ['pending', 'in_progress'],
      pendingResolutions: new Map(),
      derive: DEFAULT_DERIVE_CONFIG,
      transitions: [{ from: 'pending', command: 'start', to: 'in_progress' }],
      facts: [{ name: 'shipped', type: 'bool', binds: null }],
      factRemovalAcks: ['old'],
    });
    expect(result.body.derive).toEqual(DEFAULT_DERIVE_CONFIG);
    expect(result.body.transitions).toEqual([{ from: 'pending', command: 'start', to: 'in_progress' }]);
    expect(result.body.facts).toEqual([{ name: 'shipped', type: 'bool', binds: null }]);
    expect(result.body.factRemovalAcks).toEqual(['old']);
  });

  it('derive: null is preserved in the body (reset-to-defaults intent)', () => {
    const result = buildStatusSavePayload({
      statuses: baseStatuses,
      order: ['pending', 'in_progress'],
      pendingResolutions: new Map(),
      derive: null,
    });
    expect('derive' in result.body).toBe(true);
    expect(result.body.derive).toBeNull();
  });

  it('omits factRemovalAcks when empty', () => {
    const result = buildStatusSavePayload({
      statuses: baseStatuses,
      order: ['pending', 'in_progress'],
      pendingResolutions: new Map(),
      factRemovalAcks: [],
    });
    expect('factRemovalAcks' in result.body).toBe(false);
  });
});

describe('findStatusRuleReferences', () => {
  const derive = toEditableDerive(DEFAULT_DERIVE_CONFIG); // headline.parked='parked', blocked='blocked'
  const transitions = toEditableTransitions([
    { from: 'in_progress', command: 'block', to: 'blocked' },
    { from: 'blocked', command: 'unblock', to: 'in_progress' },
  ]);

  it('finds ladder, headline, and transition references (never disposition)', () => {
    const refs = findStatusRuleReferences('blocked', derive, transitions);
    const sections = refs.map((r) => r.section);
    expect(sections).toContain('headline');
    expect(sections).toContain('transitions');
    expect(sections).not.toContain('disposition');
    // two transitions touch 'blocked'
    expect(refs.filter((r) => r.section === 'transitions')).toHaveLength(2);
  });

  it('finds a phaseLadder rung by phase id', () => {
    const refs = findStatusRuleReferences('review', derive, []);
    expect(refs.some((r) => r.section === 'phaseLadder' && r.detail.includes('review'))).toBe(true);
  });

  it('headlineReferencesStatus detects parked/blocked refs', () => {
    expect(headlineReferencesStatus('parked', derive)).toBe(true);
    expect(headlineReferencesStatus('blocked', derive)).toBe(true);
    expect(headlineReferencesStatus('review', derive)).toBe(false);
  });
});

describe('remap vs delete resolution rewrites', () => {
  const derive = toEditableDerive(DEFAULT_DERIVE_CONFIG);
  const transitions = toEditableTransitions([
    { from: 'in_progress', command: 'block', to: 'blocked' },
    { from: 'blocked', command: 'unblock', to: 'in_progress' },
  ]);

  it('remap rewrites every ladder/headline/transition reference to the target', () => {
    const d = remapStatusInDerive(derive, 'blocked', 'paused');
    expect(d.headline.blocked).toBe('paused');
    const t = remapStatusInTransitions(transitions, 'blocked', 'paused');
    expect(t.find((r) => r.command === 'block')!.to).toBe('paused');
    expect(t.find((r) => r.command === 'unblock')!.from).toBe('paused');
  });

  it('delete drops transitions touching the id (no remap)', () => {
    const t = dropStatusFromTransitions(transitions, 'blocked');
    expect(t).toHaveLength(0);
  });

  it('delete drops ladder rungs referencing the id but remaps headline to the target', () => {
    const withRung = {
      ...derive,
      phaseLadder: [...derive.phaseLadder, { rowKey: 'x', phase: 'blocked', when: 'blocked:true', next: '' }],
    };
    const d = dropStatusFromDerive(withRung, 'blocked', 'paused');
    expect(d.phaseLadder.some((r) => r.phase === 'blocked')).toBe(false);
    expect(d.headline.blocked).toBe('paused');
  });
});

describe('pruneStaleResolutions', () => {
  it('drops resolutions whose id has returned to the saved set (user re-added)', () => {
    const pending = new Map<string, StatusResolution>([
      ['pending', { id: 'pending', mode: 'remap', target: 'in_progress' }],
    ]);
    const next = pruneStaleResolutions(pending, new Set(['pending', 'in_progress']));
    expect(next.size).toBe(0);
  });

  it('drops remap resolutions whose target has been removed', () => {
    const pending = new Map<string, StatusResolution>([
      ['pending', { id: 'pending', mode: 'remap', target: 'in_progress' }],
    ]);
    const next = pruneStaleResolutions(pending, new Set(['completed'])); // in_progress gone
    expect(next.size).toBe(0);
  });

  it('keeps delete resolutions even if no target check applies', () => {
    const pending = new Map<string, StatusResolution>([
      ['pending', { id: 'pending', mode: 'delete' }],
    ]);
    const next = pruneStaleResolutions(pending, new Set(['in_progress']));
    expect(next.size).toBe(1);
    expect(next.get('pending')).toEqual({ id: 'pending', mode: 'delete' });
  });
});

describe('sortStatusesByOrder', () => {
  const defs = [
    { id: 'pending', label: 'Pending' },
    { id: 'in_progress', label: 'In Progress' },
    { id: 'done', label: 'Done' },
  ];

  it('reorders rows to match the persisted display order', () => {
    const result = sortStatusesByOrder(defs, ['done', 'pending', 'in_progress']);
    expect(result.map((s) => s.id)).toEqual(['done', 'pending', 'in_progress']);
  });

  it('appends statuses missing from order, keeping their relative order', () => {
    const result = sortStatusesByOrder(defs, ['done']);
    expect(result.map((s) => s.id)).toEqual(['done', 'pending', 'in_progress']);
  });

  it('ignores order ids with no matching status', () => {
    const result = sortStatusesByOrder(defs, ['ghost', 'done', 'pending', 'in_progress']);
    expect(result.map((s) => s.id)).toEqual(['done', 'pending', 'in_progress']);
  });

  it('returns statuses unchanged when order is empty', () => {
    const result = sortStatusesByOrder(defs, []);
    expect(result.map((s) => s.id)).toEqual(['pending', 'in_progress', 'done']);
  });

  it('never drops rows when two statuses share an id (no silent loss)', () => {
    const dupes = [
      { id: 'dup', label: 'First' },
      { id: 'in_progress', label: 'In Progress' },
      { id: 'dup', label: 'Second' },
    ];
    const result = sortStatusesByOrder(dupes, ['dup', 'in_progress']);
    // Both 'dup' rows survive (keyed-Map dedup would have lost one).
    expect(result).toHaveLength(3);
    expect(result.map((s) => s.label)).toEqual(['First', 'Second', 'In Progress']);
  });
});
