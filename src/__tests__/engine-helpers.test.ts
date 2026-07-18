import { describe, expect, it } from 'vitest';
import { placeTicketCapped, crossedGates } from '../lifecycle/stage-engine.js';
import type { EngineInput } from '../lifecycle/stage-engine.js';
import type { StageWorkflow } from '../utils/stage-model.js';
import type { AssignmentFacts } from '../lifecycle/derive.js';

const WF: StageWorkflow = {
  id: 'w',
  stages: [
    { id: 'a', gate: [{ check: 'g1' }], next: [{ to: 'b' }] },
    { id: 'b', gate: [{ check: 'g2' }], next: [{ to: 'c' }] },
    { id: 'c', gate: [{ check: 'g3' }], next: [{ to: 'done' }] },
    { id: 'done', terminal: true, reopen: 'b' },
  ],
};

const input = (facts: Record<string, unknown>): EngineInput => ({
  facts: facts as unknown as AssignmentFacts,
  evidence: {},
  firedDissents: new Set(),
});

describe('placeTicketCapped', () => {
  it('stops at the cap even when the cap gate would pass', () => {
    // all gates pass → uncapped placement would reach terminal; cap at 'b'.
    expect(placeTicketCapped(WF, input({ g1: true, g2: true, g3: true }), 'b')).toBe('b');
  });

  it('lands earlier than the cap when an upstream gate fails', () => {
    // g1 passes, g2 fails → lands at 'b' (can't leave b); cap 'c' not reached.
    expect(placeTicketCapped(WF, input({ g1: true, g2: false, g3: true }), 'c')).toBe('b');
  });

  it('lands at the head when the first gate fails', () => {
    expect(placeTicketCapped(WF, input({ g1: false }), 'c')).toBe('a');
  });
});

describe('crossedGates', () => {
  it('returns the failing gates on the forward slice [from, to)', () => {
    // force a→c: crosses a (g1 fail) and b (g2 fail); c is the target (excluded).
    const crossed = crossedGates(WF, 'a', 'c', input({ g1: false, g2: false, g3: false }));
    expect(crossed.map((c) => c.label)).toEqual(['g1', 'g2']);
    expect(crossed.every((c) => c.overridden === true && c.passed === false)).toBe(true);
    // Each entry carries its OWN stage id (codex review major 3), not the source.
    expect(crossed.map((c) => c.stage)).toEqual(['a', 'b']);
  });

  it('omits passing gates on the slice', () => {
    const crossed = crossedGates(WF, 'a', 'c', input({ g1: true, g2: false }));
    expect(crossed.map((c) => c.label)).toEqual(['g2']);
  });

  it('returns [] for a backward move (not strictly forward)', () => {
    expect(crossedGates(WF, 'c', 'a', input({ g1: false, g2: false }))).toEqual([]);
  });

  it('returns [] for a same-stage move', () => {
    expect(crossedGates(WF, 'b', 'b', input({ g2: false }))).toEqual([]);
  });
});
