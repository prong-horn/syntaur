import { describe, it, expect } from 'vitest';
import {
  resolveStatusAppearance,
  isTerminalStatus,
  deriveStatusOptions,
  STAGE_LABELS,
} from '../../dashboard/src/lib/statusMeta';
import type { StatusConfigResponse, StatusDefinition } from '../../dashboard/src/hooks/useStatusConfig';
import { STAGE_TABLE } from '../../dashboard/src/hooks/useStatusConfig';

const stages: StatusDefinition[] = [
  { id: 'backlog', label: 'Backlog', color: '#64748b' },
  { id: 'planning', label: 'Planning', color: '#60a5fa' },
  { id: 'ready', label: 'Ready', color: 'blue' },
  { id: 'in_progress', label: 'In Progress' },
  { id: 'review', label: 'Review', color: 'amber' },
  { id: 'done', label: 'Done', color: '#22c55e', terminal: true },
  { id: 'dropped', label: 'Dropped', color: '#dc2626', terminal: true },
];

function configOf(partial: Partial<StatusConfigResponse>): StatusConfigResponse {
  return { statuses: [], order: [], ...partial } as StatusConfigResponse;
}

describe('resolveStatusAppearance', () => {
  it('uses the config label for a known stage', () => {
    expect(resolveStatusAppearance(stages, 'planning').label).toBe('Planning');
  });

  it('title-cases an unknown stage as a fallback', () => {
    const appearance = resolveStatusAppearance(stages, 'mystery_stage');
    expect(appearance.label).toBe('Mystery Stage');
    expect(appearance.className).toContain('bg-status-pending');
    expect(appearance.style).toBeUndefined();
  });

  it('derives an inline style from a hex color (no color class)', () => {
    const appearance = resolveStatusAppearance(stages, 'backlog');
    expect(appearance.className).toBe('');
    expect(appearance.style).toBeDefined();
    expect(appearance.style?.backgroundColor).toBe('rgba(100, 116, 139, 0.15)');
    expect(appearance.style?.borderColor).toBe('rgba(100, 116, 139, 0.4)');
    expect(appearance.style?.color).toBe('#64748b');
  });

  it('maps a named token to a class with no style', () => {
    const ready = resolveStatusAppearance(stages, 'ready');
    expect(ready.className).toContain('bg-status-in-progress');
    expect(ready.style).toBeUndefined();
  });

  it('keeps the built-in class for a known stage that has no config color', () => {
    const appearance = resolveStatusAppearance(stages, 'in_progress');
    expect(appearance.className).toContain('bg-status-in-progress');
    expect(appearance.style).toBeUndefined();
  });
});

describe('isTerminalStatus', () => {
  it('is true for an explicit terminal flag', () => {
    expect(isTerminalStatus({ id: 'archived', terminal: true })).toBe(true);
  });

  it('is true for done and dropped even without a flag', () => {
    expect(isTerminalStatus({ id: 'done' })).toBe(true);
    expect(isTerminalStatus({ id: 'dropped' })).toBe(true);
  });

  it('is false for non-terminal stages and for undefined', () => {
    expect(isTerminalStatus({ id: 'in_progress' })).toBe(false);
    expect(isTerminalStatus(undefined)).toBe(false);
  });
});

describe('deriveStatusOptions', () => {
  it('follows config.order and flags terminal stages', () => {
    const config = configOf({
      statuses: stages,
      order: ['backlog', 'planning', 'ready', 'in_progress', 'review', 'done', 'dropped'],
    });
    const options = deriveStatusOptions(config);
    expect(options.map((o) => o.id)).toEqual([
      'backlog',
      'planning',
      'ready',
      'in_progress',
      'review',
      'done',
      'dropped',
    ]);
    expect(options.find((o) => o.id === 'planning')?.label).toBe('Planning');
    expect(options.find((o) => o.id === 'done')?.terminal).toBe(true);
    expect(options.find((o) => o.id === 'dropped')?.terminal).toBe(true);
    expect(options.find((o) => o.id === 'planning')?.terminal).toBe(false);
  });

  it('falls back to statuses order when config.order is empty', () => {
    const config = configOf({ statuses: stages, order: [] });
    expect(deriveStatusOptions(config).map((o) => o.id)).toEqual(stages.map((s) => s.id));
  });
});

describe('STAGE_LABELS', () => {
  it('mirrors the fixed stage table', () => {
    for (const stage of STAGE_TABLE) {
      expect(STAGE_LABELS[stage.id]).toBe(stage.label);
    }
  });
});
