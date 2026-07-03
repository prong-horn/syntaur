import { describe, it, expect } from 'vitest';
import {
  laneColumns,
  buildWorkflowLanes,
  isMixedWorkflow,
  type WorkflowBoardItem,
} from '../../dashboard/src/lib/workflow-board';

function item(
  resolvedWorkflow: string,
  workflowLabel: string,
  status: string,
): WorkflowBoardItem {
  return { resolvedWorkflow, workflowLabel, status };
}

/** A large mixed-workflow fixture: 3 workflows, 300 items, interleaved. */
function bigFixture(): WorkflowBoardItem[] {
  const workflows = [
    { id: 'default', label: 'Default', statuses: ['pending', 'in_progress', 'completed'] },
    { id: 'bug', label: 'Bug', statuses: ['open', 'triage', 'fixed'] },
    { id: 'rfc', label: 'RFC', statuses: ['draft', 'review', 'accepted'] },
  ];
  const out: WorkflowBoardItem[] = [];
  for (let i = 0; i < 300; i++) {
    const wf = workflows[i % workflows.length];
    out.push(item(wf.id, wf.label, wf.statuses[i % wf.statuses.length]));
  }
  return out;
}

describe('laneColumns', () => {
  it('uses the workflow order verbatim when provided', () => {
    const cols = laneColumns([item('bug', 'Bug', 'open')], ['open', 'triage', 'fixed']);
    expect(cols).toEqual(['open', 'triage', 'fixed']);
  });

  it('derives columns from present statuses in default-board order', () => {
    const items = [
      item('default', 'Default', 'completed'),
      item('default', 'Default', 'in_progress'),
      item('default', 'Default', 'blocked'),
    ];
    // default order is draft/pending/ready.../in_progress/blocked/review/completed/failed
    expect(laneColumns(items)).toEqual(['in_progress', 'blocked', 'completed']);
  });

  it('appends unknown statuses alphabetically after known ones', () => {
    const items = [
      item('x', 'X', 'zeta'),
      item('x', 'X', 'in_progress'),
      item('x', 'X', 'alpha'),
    ];
    expect(laneColumns(items)).toEqual(['in_progress', 'alpha', 'zeta']);
  });

  it('deduplicates repeated statuses', () => {
    const items = [
      item('x', 'X', 'in_progress'),
      item('x', 'X', 'in_progress'),
      item('x', 'X', 'completed'),
    ];
    expect(laneColumns(items)).toEqual(['in_progress', 'completed']);
  });
});

describe('buildWorkflowLanes', () => {
  it('groups items into lanes ordered by first appearance', () => {
    const items = [
      item('bug', 'Bug', 'open'),
      item('default', 'Default', 'pending'),
      item('bug', 'Bug', 'fixed'),
      item('default', 'Default', 'completed'),
    ];
    const lanes = buildWorkflowLanes(items);
    expect(lanes.map((l) => l.workflowId)).toEqual(['bug', 'default']);
    expect(lanes[0].items).toHaveLength(2);
    expect(lanes[1].items).toHaveLength(2);
    expect(lanes[0].label).toBe('Bug');
  });

  it('applies per-workflow order when supplied', () => {
    const items = [item('bug', 'Bug', 'open'), item('bug', 'Bug', 'fixed')];
    const lanes = buildWorkflowLanes(items, { bug: ['open', 'triage', 'fixed'] });
    expect(lanes[0].columns).toEqual(['open', 'triage', 'fixed']);
  });

  it('handles a large mixed fixture without cross-lane leakage', () => {
    const items = bigFixture();
    const lanes = buildWorkflowLanes(items, {
      default: ['pending', 'in_progress', 'completed'],
      bug: ['open', 'triage', 'fixed'],
      rfc: ['draft', 'review', 'accepted'],
    });
    expect(lanes.map((l) => l.workflowId)).toEqual(['default', 'bug', 'rfc']);
    // 300 items / 3 workflows evenly interleaved → 100 each.
    for (const lane of lanes) {
      expect(lane.items).toHaveLength(100);
      // every item in a lane resolves to that lane's workflow
      expect(lane.items.every((i) => i.resolvedWorkflow === lane.workflowId)).toBe(true);
    }
    expect(lanes.find((l) => l.workflowId === 'bug')!.columns).toEqual(['open', 'triage', 'fixed']);
  });

  it('falls back to the workflow id when no label is present', () => {
    const lanes = buildWorkflowLanes([item('ghost', '', 'open')]);
    expect(lanes[0].label).toBe('ghost');
  });

  it('returns an empty array for no items', () => {
    expect(buildWorkflowLanes([])).toEqual([]);
  });
});

describe('isMixedWorkflow', () => {
  it('is false for empty or single-workflow sets', () => {
    expect(isMixedWorkflow([])).toBe(false);
    expect(isMixedWorkflow([item('bug', 'Bug', 'open'), item('bug', 'Bug', 'fixed')])).toBe(false);
  });

  it('is true when more than one workflow is present', () => {
    expect(
      isMixedWorkflow([item('bug', 'Bug', 'open'), item('default', 'Default', 'pending')]),
    ).toBe(true);
  });
});
