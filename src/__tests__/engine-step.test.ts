import { describe, expect, it } from 'vitest';
import { computeEngineStep } from '../lifecycle/engine-step.js';
import { parseAssignmentFrontmatter } from '../lifecycle/frontmatter.js';
import type { AttestationEnv } from '../lifecycle/facts.js';
import type { AssignmentFacts } from '../lifecycle/derive.js';
import type { StageWorkflow } from '../utils/stage-model.js';

const WF: StageWorkflow = {
  id: 'w',
  stages: [
    { id: 'building', gate: [{ check: 'acAllChecked' }], next: [{ to: 'reviewing' }] },
    { id: 'reviewing', gate: [{ check: 'reviewOk' }], next: [{ to: 'done' }] },
    { id: 'done', terminal: true, reopen: 'reviewing' },
  ],
  terminalFailure: 'failed',
};

const env: AttestationEnv = { latestPlanFile: null, planDigest: null, headSha: null };

function content(status: string, extra = ''): string {
  return `---
id: a
slug: t
title: T
status: ${status}
priority: medium
created: "2026-07-09T00:00:00Z"
updated: "2026-07-09T00:00:00Z"
statusHistory: []
${extra}---
# T
`;
}

const facts = (o: Record<string, unknown>): AssignmentFacts => o as unknown as AssignmentFacts;

describe('computeEngineStep', () => {
  it('gate move: cascades forward while gates pass, freezing at terminal', () => {
    const c = content('building');
    const step = computeEngineStep({
      content: c,
      frontmatter: parseAssignmentFrontmatter(c),
      facts: facts({ acAllChecked: true, reviewOk: true }),
      workflow: WF,
      env,
      move: { kind: 'gate' },
      cause: 'derive',
      by: 'system',
      at: '2026-07-09T01:00:00Z',
    });
    expect(step).not.toBeNull();
    expect(step!.finalStatus).toBe('done');
    expect(step!.terminalArrival).toBe(true);
    expect(step!.successTerminal).toBe(true);
    const fm = parseAssignmentFrontmatter(step!.nextContent);
    expect(fm.status).toBe('done');
    expect(fm.disposition).toBe('terminal');
    expect(fm.frozenChecks).not.toBeNull();
    // two hops recorded (building→reviewing, reviewing→done)
    expect(fm.statusHistory.filter((h) => h.trigger === 'gate')).toHaveLength(2);
  });

  it('gate move: stops at a failing gate (no change)', () => {
    const c = content('building');
    const step = computeEngineStep({
      content: c,
      frontmatter: parseAssignmentFrontmatter(c),
      facts: facts({ acAllChecked: false }),
      workflow: WF,
      env,
      move: { kind: 'gate' },
      cause: 'derive',
      by: 'system',
      at: '2026-07-09T01:00:00Z',
    });
    expect(step!.changed).toBe(false);
    expect(step!.finalStatus).toBe('building');
  });

  it('manual-override: forces past a failing gate and stamps the crossed gate', () => {
    const c = content('building');
    const step = computeEngineStep({
      content: c,
      frontmatter: parseAssignmentFrontmatter(c),
      facts: facts({ acAllChecked: false, reviewOk: false }),
      workflow: WF,
      env,
      move: { kind: 'manual-override', target: 'reviewing', actor: 'human' },
      cause: 'move',
      by: 'human',
      reason: 'expedite',
      at: '2026-07-09T02:00:00Z',
    });
    expect(step!.finalStatus).toBe('reviewing');
    const fm = parseAssignmentFrontmatter(step!.nextContent);
    expect(fm.status).toBe('reviewing');
    expect(fm.gateOverrides).toHaveLength(1);
    expect(fm.gateOverrides[0]).toMatchObject({
      stage: 'building',
      label: 'acAllChecked',
      from: 'building',
      to: 'reviewing',
      actor: 'human',
      reason: 'expedite',
    });
    const hop = fm.statusHistory.find((h) => h.trigger === 'manual-override');
    expect(hop).toBeDefined();
    expect(hop!.route).toBeUndefined(); // forced move has no engine route
  });

  it('backward manual-override writes NO gate override', () => {
    const c = content('reviewing');
    const step = computeEngineStep({
      content: c,
      frontmatter: parseAssignmentFrontmatter(c),
      facts: facts({ reviewOk: false }),
      workflow: WF,
      env,
      move: { kind: 'manual-override', target: 'building', actor: 'human' },
      cause: 'move',
      by: 'human',
      at: '2026-07-09T02:00:00Z',
    });
    expect(step!.finalStatus).toBe('building');
    const fm = parseAssignmentFrontmatter(step!.nextContent);
    expect(fm.gateOverrides).toEqual([]);
  });

  it('reopen: re-places from terminal and clears the freeze', () => {
    // A done ticket with frozenChecks; reopen caps at reviewing (the reopen target).
    const c = content('done', 'frozenChecks:\n  - key: "done:0"\n    label: reviewOk\n    passed: true\n');
    const fm0 = parseAssignmentFrontmatter(c);
    expect(fm0.frozenChecks).not.toBeNull();
    const step = computeEngineStep({
      content: c,
      frontmatter: fm0,
      facts: facts({ acAllChecked: true, reviewOk: false }),
      workflow: WF,
      env,
      move: { kind: 'reopen' },
      cause: 'reopen',
      by: 'human',
      at: '2026-07-09T03:00:00Z',
    });
    expect(step!.finalStatus).toBe('reviewing');
    const fm = parseAssignmentFrontmatter(step!.nextContent);
    expect(fm.status).toBe('reviewing');
    expect(fm.frozenChecks).toBeNull(); // freeze cleared
    expect(fm.statusHistory.find((h) => h.trigger === 'reopen')).toBeDefined();
  });

  it('returns null when the stored status is not a stage in the workflow', () => {
    const c = content('some_legacy_status');
    const step = computeEngineStep({
      content: c,
      frontmatter: parseAssignmentFrontmatter(c),
      facts: facts({}),
      workflow: WF,
      env,
      move: { kind: 'gate' },
      cause: 'derive',
      by: 'system',
      at: '2026-07-09T04:00:00Z',
    });
    expect(step).toBeNull();
  });

  it('multi-stage manual-override stamps each crossed gate against its OWN stage', () => {
    // Force building→done across two failing gates (building:acAllChecked,
    // reviewing:reviewOk); each override records the gate's own stage (major 3).
    const c = content('building');
    const step = computeEngineStep({
      content: c,
      frontmatter: parseAssignmentFrontmatter(c),
      facts: facts({ acAllChecked: false, reviewOk: false }),
      workflow: WF,
      env,
      move: { kind: 'manual-override', target: 'done', actor: 'human' },
      cause: 'move',
      by: 'human',
      at: '2026-07-09T05:00:00Z',
    });
    const fm = parseAssignmentFrontmatter(step!.nextContent);
    expect(fm.status).toBe('done');
    expect(fm.gateOverrides.map((o) => o.stage).sort()).toEqual(['building', 'reviewing']);
    const building = fm.gateOverrides.find((o) => o.stage === 'building')!;
    expect(building).toMatchObject({ stage: 'building', label: 'acAllChecked' });
    const reviewing = fm.gateOverrides.find((o) => o.stage === 'reviewing')!;
    expect(reviewing).toMatchObject({ stage: 'reviewing', label: 'reviewOk' });
  });

  it('self-clears an override for an EARLIER stage once that stage gate passes', () => {
    // Ticket sits in reviewing with a lingering override for building's gate.
    // A derive with acAllChecked now true must clear it even though the status
    // does not move (codex review major 2).
    const existing =
      'gateOverrides:\n  - stage: building\n    key: "building:0"\n    label: acAllChecked\n    from: building\n    to: reviewing\n    actor: human\n    at: "2026-07-09T05:00:00Z"\n';
    const c = content('reviewing', existing);
    expect(parseAssignmentFrontmatter(c).gateOverrides).toHaveLength(1);
    const step = computeEngineStep({
      content: c,
      frontmatter: parseAssignmentFrontmatter(c),
      facts: facts({ acAllChecked: true, reviewOk: false }), // reviewOk fails → stays in reviewing
      workflow: WF,
      env,
      move: { kind: 'gate' },
      cause: 'derive',
      by: 'system',
      at: '2026-07-09T06:00:00Z',
    });
    expect(step!.changed).toBe(true); // the clear itself is a change
    const fm = parseAssignmentFrontmatter(step!.nextContent);
    expect(fm.status).toBe('reviewing'); // no move
    expect(fm.gateOverrides).toEqual([]); // building override cleared
  });

  // ── work-start verb discriminator (WS-3 Task 0 / Decision 4) ───────────────
  describe('work-start verb discriminator', () => {
    // The compiled-default shape: in_progress's only work-start route carries
    // `verb: request-review`; review routes back on `verb: rework`.
    const VWF: StageWorkflow = {
      id: 'v',
      stages: [
        {
          id: 'in_progress',
          gate: [{ check: '', condition: 'acAllChecked:true' }],
          next: [
            { to: 'review', on: 'gate' },
            { to: 'review', on: 'work-start', verb: 'request-review' },
          ],
        },
        { id: 'review', next: [{ to: 'in_progress', on: 'work-start', verb: 'rework' }] },
      ],
    };

    function step(status: string, verb: string | undefined) {
      const c = content(status);
      return computeEngineStep({
        content: c,
        frontmatter: parseAssignmentFrontmatter(c),
        facts: facts({ acAllChecked: false }),
        workflow: VWF,
        env,
        move: { kind: 'work-start', verb },
        cause: 'work-start',
        by: 'human',
        at: '2026-07-09T07:00:00Z',
      });
    }

    it('`implement` at in_progress matches NO route (round-3 blocker) — no move', () => {
      const s = step('in_progress', 'implement');
      expect(s!.changed).toBe(false);
      expect(s!.finalStatus).toBe('in_progress');
    });

    it('the matching verb moves: request-review fires in_progress → review', () => {
      const s = step('in_progress', 'request-review');
      expect(s!.changed).toBe(true);
      expect(s!.finalStatus).toBe('review');
    });

    it('rework fires review → in_progress; other verbs do not', () => {
      expect(step('review', 'rework')!.finalStatus).toBe('in_progress');
      expect(step('review', 'implement')!.changed).toBe(false);
      expect(step('review', undefined)!.changed).toBe(false);
    });
  });
});
