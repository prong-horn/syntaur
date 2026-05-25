import { describe, it, expect } from 'vitest';
import {
  buildStatusSavePayload,
  pruneStaleResolutions,
} from '../../dashboard/src/pages/settings-page-helpers';
import type { StatusResolution } from '../../dashboard/src/hooks/useStatusConfig';

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
