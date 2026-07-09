import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import {
  parseWorkflowFile,
  serializeWorkflowFile,
  workflowFilePath,
  isValidWorkflowId,
} from '../utils/workflow-file.js';

// The design §2.2 authored example — the canonical stage-model shape.
const EXAMPLE = `id: feature
label: Feature
stages:
  - id: shaping
    label: Shaping
    color: "#64748b"
    guidance: Fill in the objective and acceptance criteria
    work: { agent: planner, playbooks: [read-before-plan] }
    gate:
      - { check: hasRealObjective }
      - { check: "acRealTotal > 0" }
    next:
      - { to: planning, on: gate }
  - id: ready
    next: [{ to: implementing, on: work-start }]
  - id: reviewing
    gate:
      - { check: codeReviewed, by: not-author, judge: reviewer, binds: commit }
    next: [{ to: done }]
    on-dissent: implementing
  - id: done
    terminal: true
    reopen: ready
flags:
  blocked: { when: blocked }
  parked: { when: parked }
  hold: {}
terminal_failure: failed
`;

describe('parseWorkflowFile / serializeWorkflowFile', () => {
  it('parses the §2.2 example with no issues and the expected shape', () => {
    const { workflow, issues } = parseWorkflowFile(EXAMPLE);
    expect(issues).toEqual([]);
    expect(workflow.id).toBe('feature');
    expect(workflow.label).toBe('Feature');
    expect(workflow.stages.map((s) => s.id)).toEqual(['shaping', 'ready', 'reviewing', 'done']);
    // kebab/snake on-disk keys map to camelCase.
    expect(workflow.stages[2].onDissent).toBe('implementing');
    expect(workflow.terminalFailure).toBe('failed');
    // color quoting preserved (# would be a yaml comment unquoted).
    expect(workflow.stages[0].color).toBe('#64748b');
    // work + gate qualifiers.
    expect(workflow.stages[0].work).toEqual({ agent: 'planner', playbooks: ['read-before-plan'] });
    expect(workflow.stages[2].gate?.[0]).toEqual({
      check: 'codeReviewed',
      by: 'not-author',
      judge: 'reviewer',
      binds: 'commit',
    });
    // route default `on` is preserved-as-absent (default-gate is an eval concern).
    expect(workflow.stages[2].next).toEqual([{ to: 'done' }]);
    expect(workflow.stages[0].next).toEqual([{ to: 'planning', on: 'gate' }]);
    // empty flag body round-trips as {}.
    expect(workflow.flags?.hold).toEqual({});
  });

  it('round-trips the §2.2 example losslessly (data-lossless)', () => {
    const first = parseWorkflowFile(EXAMPLE);
    const yaml = serializeWorkflowFile(first.workflow);
    const second = parseWorkflowFile(yaml);
    expect(second.issues).toEqual([]);
    expect(second.workflow).toEqual(first.workflow);
  });

  it('preserves a malformed gate check + surfaces it in issues (never dropped)', () => {
    const raw = `id: buggy
stages:
  - id: s1
    gate:
      - { bogus: true }
    next: [{ to: done }]
  - id: done
    terminal: true
`;
    const { workflow, issues } = parseWorkflowFile(raw);
    expect(issues.some((i) => i.includes("neither a 'check' nor a 'condition'"))).toBe(true);
    // The unknown key is preserved on the check's raw passthrough, not deleted.
    expect(workflow.stages[0].gate?.[0].raw).toEqual({ bogus: true });
    // And it survives a serialize→parse round-trip.
    const round = parseWorkflowFile(serializeWorkflowFile(workflow));
    expect(round.workflow.stages[0].gate?.[0].raw).toEqual({ bogus: true });
  });

  it('coerces a bare-string route to { to } and preserves unknown top-level keys', () => {
    const raw = `id: shorthand
customTopLevel: kept
stages:
  - id: a
    next:
      - b
  - id: b
    terminal: true
`;
    const { workflow } = parseWorkflowFile(raw);
    expect(workflow.stages[0].next).toEqual([{ to: 'b' }]);
    expect(workflow.raw).toEqual({ customTopLevel: 'kept' });
  });

  it('never throws on a yaml syntax error — reports it as an issue', () => {
    const { workflow, issues } = parseWorkflowFile('id: x\n  : : bad');
    expect(issues.length).toBeGreaterThan(0);
    expect(workflow.stages).toEqual([]);
  });
});

describe('workflowFilePath', () => {
  const original = process.env.SYNTAUR_HOME;
  beforeEach(() => {
    process.env.SYNTAUR_HOME = '/tmp/syntaur-test-home';
  });
  afterEach(() => {
    if (original === undefined) delete process.env.SYNTAUR_HOME;
    else process.env.SYNTAUR_HOME = original;
  });

  it('resolves to <root>/workflows/<id>.md', () => {
    expect(workflowFilePath('feature')).toBe(
      resolve('/tmp/syntaur-test-home', 'workflows', 'feature.md'),
    );
  });

  it('throws on an invalid id rather than escaping the workflows dir', () => {
    // `../config` would otherwise resolve to ~/.syntaur/config.md.
    expect(() => workflowFilePath('../config')).toThrow('invalid workflow id');
    expect(() => workflowFilePath('a/b')).toThrow('invalid workflow id');
  });
});

describe('isValidWorkflowId (security boundary)', () => {
  it('accepts keyword-safe slugs', () => {
    for (const ok of ['feature', 'bug-triage', 'quick_fix2', 'A1']) {
      expect(isValidWorkflowId(ok)).toBe(true);
    }
  });

  it('rejects traversal, separators, newlines, dotfiles, empties, and over-long ids', () => {
    for (const bad of ['../config', 'a/b', 'a\\b', 'x\nworkflows:', '.hidden', '', 'a'.repeat(65)]) {
      expect(isValidWorkflowId(bad)).toBe(false);
    }
  });
});

describe('parseWorkflowFile — malformed fields are preserved, never silently corrupted', () => {
  it('a non-mapping flags: (a list) is preserved on raw, not dropped', () => {
    const { workflow, issues } = parseWorkflowFile(
      'id: w\nstages:\n  - id: done\n    terminal: true\nflags:\n  - hold\n',
    );
    expect(issues).toContain('flags must be a mapping');
    expect(workflow.flags).toBeUndefined();
    expect(workflow.raw?.flags).toEqual(['hold']);
    // Round-trips.
    const round = parseWorkflowFile(serializeWorkflowFile(workflow));
    expect(round.workflow.raw?.flags).toEqual(['hold']);
  });

  it('playbooks with non-string entries are preserved verbatim, not coerced to "[object Object]"', () => {
    const { workflow, issues } = parseWorkflowFile(
      'id: w\nstages:\n  - id: a\n    work:\n      agent: planner\n      playbooks:\n        - slug: p\n    next: [{ to: done }]\n  - id: done\n    terminal: true\n',
    );
    expect(issues.some((i) => i.includes('playbooks must be a list of strings'))).toBe(true);
    expect(workflow.stages[0].work?.playbooks).toBeUndefined();
    expect(workflow.stages[0].work?.raw?.playbooks).toEqual([{ slug: 'p' }]);
  });

  it('terminal: "false" is not coerced to true (which would invert meaning + fool doctor)', () => {
    const { workflow, issues } = parseWorkflowFile('id: w\nstages:\n  - id: a\n    terminal: "false"\n');
    expect(issues.some((i) => i.includes('terminal must be a boolean'))).toBe(true);
    expect(workflow.stages[0].terminal).toBeUndefined();
    expect(workflow.stages[0].raw?.terminal).toBe('false');
  });

  it('an object value for a string field (route.to) is preserved, not stringified to "[object Object]"', () => {
    const { workflow, issues } = parseWorkflowFile(
      'id: w\nstages:\n  - id: a\n    next:\n      - to: { stage: done }\n  - id: done\n    terminal: true\n',
    );
    expect(issues.some((i) => i.includes('next[0].to must be a string'))).toBe(true);
    const route = workflow.stages[0].next?.[0];
    expect(route?.to).toBe(''); // typed field left empty, not "[object Object]"
    expect(route?.raw?.to).toEqual({ stage: 'done' }); // original mapping preserved
    // Round-trips.
    const round = parseWorkflowFile(serializeWorkflowFile(workflow));
    expect(round.workflow.stages[0].next?.[0].raw?.to).toEqual({ stage: 'done' });
  });
});
