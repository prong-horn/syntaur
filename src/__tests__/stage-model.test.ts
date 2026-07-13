import { describe, expect, it } from 'vitest';
import {
  ROUTE_TRIGGERS,
  type StageWorkflow,
  type StageCheck,
  type StageRoute,
} from '../utils/stage-model.js';

describe('stage-model types', () => {
  it('constructs the design §2.2 example with every typed field', () => {
    const wf: StageWorkflow = {
      id: 'feature',
      label: 'Feature',
      stages: [
        {
          id: 'shaping',
          label: 'Shaping',
          color: '#64748b',
          guidance: 'Fill in the objective and acceptance criteria',
          work: { agent: 'planner', playbooks: ['read-before-plan'] },
          gate: [{ check: 'hasRealObjective' }, { check: 'acRealTotal', condition: 'acRealTotal > 0' }],
          next: [{ to: 'planning', on: 'gate' }],
        },
        { id: 'ready', next: [{ to: 'implementing', on: 'work-start' }] },
        {
          id: 'reviewing',
          gate: [{ check: 'codeReviewed', by: 'not-author', judge: 'reviewer', binds: 'commit' }],
          next: [{ to: 'done' }],
          onDissent: 'implementing',
        },
        { id: 'done', terminal: true, reopen: 'ready' },
      ],
      flags: {
        blocked: { when: 'blocked' },
        parked: { when: 'parked' },
        hold: {},
      },
      terminalFailure: 'failed',
    };

    expect(wf.stages.map((s) => s.id)).toEqual(['shaping', 'ready', 'reviewing', 'done']);
    expect(wf.stages[0].work?.playbooks).toEqual(['read-before-plan']);
    expect(wf.stages[2].gate?.[0].binds).toBe('commit');
    expect(wf.stages[3].terminal).toBe(true);
    expect(wf.flags?.hold).toEqual({});
    expect(wf.terminalFailure).toBe('failed');
  });

  it('exposes the four route triggers', () => {
    expect(ROUTE_TRIGGERS).toEqual(['gate', 'work-start', 'manual']);
  });

  it('preserves unrecognized keys on the raw passthrough (no silent deletion)', () => {
    const check: StageCheck = { check: 'x', raw: { futureKey: 42 } };
    const route: StageRoute = { to: 'y', raw: { weight: 3 } };
    const wf: StageWorkflow = {
      id: 'w',
      stages: [{ id: 's', raw: { experimental: true } }],
      raw: { topLevelFuture: 'kept' },
    };
    expect(check.raw?.futureKey).toBe(42);
    expect(route.raw?.weight).toBe(3);
    expect(wf.stages[0].raw?.experimental).toBe(true);
    expect(wf.raw?.topLevelFuture).toBe('kept');
  });

  it('allows custom flag names beyond the built-in trio', () => {
    const wf: StageWorkflow = {
      id: 'w',
      stages: [{ id: 's' }],
      flags: { hold: {}, needsSecurityReview: { when: 'touchesAuth' } },
    };
    expect(wf.flags?.needsSecurityReview?.when).toBe('touchesAuth');
  });
});
