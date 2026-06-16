import { describe, it, expect } from 'vitest';
import {
  resolveStatusAppearance,
  isTerminalStatus,
  deriveStatusOptions,
} from '../../dashboard/src/lib/statusMeta';
import type { StatusConfigResponse, StatusDefinition } from '../../dashboard/src/hooks/useStatusConfig';

// The resolver is pure and React-free, so it runs under the node-env root vitest
// (root config includes only src/__tests__/**, not dashboard/src). See plan Task 6.

const statuses: StatusDefinition[] = [
  { id: 'draft', label: 'Draft', color: '#64748b' },
  { id: 'planning', label: 'Planning', color: '#60a5fa' },
  { id: 'parked', label: 'Parked', color: 'slate' },
  { id: 'in_progress', label: 'In Progress' },
  { id: 'completed', label: 'Completed', color: '#22c55e', terminal: true },
  { id: 'failed', label: 'Failed', color: '#dc2626' },
];

function configOf(partial: Partial<StatusConfigResponse>): StatusConfigResponse {
  return { statuses: [], order: [], ...partial } as StatusConfigResponse;
}

describe('resolveStatusAppearance', () => {
  it('uses the config label for a known status', () => {
    expect(resolveStatusAppearance(statuses, 'planning').label).toBe('Planning');
  });

  it('title-cases an unknown status as a fallback', () => {
    const appearance = resolveStatusAppearance(statuses, 'ready_for_planning');
    expect(appearance.label).toBe('Ready For Planning');
    // Unknown → neutral pill, no inline style.
    expect(appearance.className).toContain('bg-status-pending');
    expect(appearance.style).toBeUndefined();
  });

  it('derives an inline style from a hex color (no color class)', () => {
    const appearance = resolveStatusAppearance(statuses, 'draft');
    expect(appearance.className).toBe('');
    expect(appearance.style).toBeDefined();
    // #64748b → rgb(100, 116, 139)
    expect(appearance.style?.backgroundColor).toBe('rgba(100, 116, 139, 0.15)');
    expect(appearance.style?.borderColor).toBe('rgba(100, 116, 139, 0.4)');
    expect(appearance.style?.color).toBe('#64748b');
  });

  it('expands a 3-digit hex color', () => {
    const appearance = resolveStatusAppearance([{ id: 'x', label: 'X', color: '#abc' }], 'x');
    // #abc → #aabbcc → rgb(170, 187, 204)
    expect(appearance.style?.color).toBe('#abc');
    expect(appearance.style?.backgroundColor).toBe('rgba(170, 187, 204, 0.15)');
  });

  it('maps a named token to a class with no style, falling back to neutral', () => {
    const parked = resolveStatusAppearance(statuses, 'parked');
    expect(parked.className).toContain('bg-status-pending');
    expect(parked.style).toBeUndefined();
  });

  it('keeps the built-in class for a known status that has no config color', () => {
    // Boot / fetch-failure case: DEFAULT_STATUS_CONFIG carries labels only, so a
    // built-in must NOT regress to the neutral pill.
    const appearance = resolveStatusAppearance(statuses, 'in_progress');
    expect(appearance.className).toContain('bg-status-in-progress');
    expect(appearance.style).toBeUndefined();
  });

  it('uses the neutral class for an unknown status with no color', () => {
    const appearance = resolveStatusAppearance(statuses, 'totally_unknown_xyz');
    expect(appearance.className).toContain('bg-status-pending');
    expect(appearance.style).toBeUndefined();
  });

  it('ignores an unparseable hex and falls back to neutral', () => {
    const appearance = resolveStatusAppearance([{ id: 'x', label: 'X', color: '#zzzzzz' }], 'x');
    expect(appearance.className).toContain('bg-status-pending');
    expect(appearance.style).toBeUndefined();
  });
});

describe('isTerminalStatus', () => {
  it('is true for an explicit terminal flag', () => {
    expect(isTerminalStatus({ id: 'archived', terminal: true })).toBe(true);
  });

  it('is true for completed and failed even without a flag', () => {
    expect(isTerminalStatus({ id: 'completed' })).toBe(true);
    expect(isTerminalStatus({ id: 'failed' })).toBe(true);
  });

  it('is false for non-terminal statuses and for undefined', () => {
    expect(isTerminalStatus({ id: 'in_progress' })).toBe(false);
    expect(isTerminalStatus(undefined)).toBe(false);
  });
});

describe('deriveStatusOptions', () => {
  it('follows config.order, includes custom statuses, and flags terminal entries', () => {
    const config = configOf({
      statuses,
      order: ['draft', 'planning', 'parked', 'in_progress', 'completed', 'failed'],
    });
    const options = deriveStatusOptions(config);
    expect(options.map((o) => o.id)).toEqual([
      'draft',
      'planning',
      'parked',
      'in_progress',
      'completed',
      'failed',
    ]);
    expect(options.find((o) => o.id === 'planning')?.label).toBe('Planning');
    expect(options.find((o) => o.id === 'completed')?.terminal).toBe(true);
    expect(options.find((o) => o.id === 'failed')?.terminal).toBe(true);
    expect(options.find((o) => o.id === 'planning')?.terminal).toBe(false);
  });

  it('appends statuses missing from order and de-dupes', () => {
    const config = configOf({
      statuses,
      order: ['planning', 'planning', 'draft'],
    });
    const ids = deriveStatusOptions(config).map((o) => o.id);
    // ordered first (de-duped), then the remaining statuses in declaration order.
    expect(ids).toEqual(['planning', 'draft', 'parked', 'in_progress', 'completed', 'failed']);
  });

  it('falls back to statuses order when config.order is empty', () => {
    const config = configOf({ statuses, order: [] });
    expect(deriveStatusOptions(config).map((o) => o.id)).toEqual(statuses.map((s) => s.id));
  });

  it('title-cases a label for an ordered id missing from statuses', () => {
    const config = configOf({ statuses, order: ['mystery_state', 'draft'] });
    const options = deriveStatusOptions(config);
    expect(options[0]).toEqual({ id: 'mystery_state', label: 'Mystery State', terminal: false });
  });
});
