import { describe, it, expect } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll } from 'vitest';
import { DEFAULT_DERIVE_CONFIG } from '../utils/config.js';
import {
  deriveDimensions,
  validateDeriveCondition,
  type AssignmentFacts,
} from '../lifecycle/derive.js';
import {
  computeFacts,
  countRealAcceptanceCriteria,
  hasRealObjective,
  isPlanApproved,
  latestPlanFile,
  planDigest,
} from '../lifecycle/facts.js';
import { parseAssignmentFrontmatter } from '../lifecycle/frontmatter.js';

const TERMINALS = new Set(['completed', 'failed']);
const KNOWN = new Set([
  'draft',
  'pending',
  'ready_for_planning',
  'ready_to_implement',
  'in_progress',
  'blocked',
  'review',
  'completed',
  'failed',
]);

const BASE_FACTS: AssignmentFacts = {
  hasRealObjective: false,
  acRealTotal: 0,
  acRealChecked: 0,
  acAllChecked: false,
  planExists: false,
  planApproved: false,
  workspaceSet: false,
  implementationStarted: false,
  depsSatisfied: true,
  unresolvedQuestions: 0,
  blocked: false,
  parked: false,
  reviewRequested: false,
  pinned: false,
};

function derive(facts: Partial<AssignmentFacts>, overrides: Partial<Parameters<typeof deriveDimensions>[0]> = {}) {
  return deriveDimensions({
    facts: { ...BASE_FACTS, ...facts },
    derive: DEFAULT_DERIVE_CONFIG,
    currentStatus: 'draft',
    terminalStatuses: TERMINALS,
    knownStatusIds: KNOWN,
    override: null,
    ...overrides,
  });
}

describe('deriveDimensions — phase ladder', () => {
  it('empty assignment → draft', () => {
    const d = derive({})!;
    expect(d.phase).toBe('draft');
    expect(d.disposition).toBe('active');
    expect(d.status).toBe('draft');
    expect(d.nextAction).toContain('objective');
  });

  it('real objective + ACs → ready_for_planning', () => {
    const d = derive({ hasRealObjective: true, acRealTotal: 3 })!;
    expect(d.phase).toBe('ready_for_planning');
  });

  it('plan approved → ready_to_implement (the motivating rule)', () => {
    const d = derive({ hasRealObjective: true, acRealTotal: 3, planExists: true, planApproved: true })!;
    expect(d.phase).toBe('ready_to_implement');
    expect(d.status).toBe('ready_to_implement');
  });

  it('approved + implementation started → in_progress', () => {
    const d = derive({ hasRealObjective: true, acRealTotal: 3, planApproved: true, implementationStarted: true })!;
    expect(d.phase).toBe('in_progress');
  });

  it('all ACs checked → review (highest rung wins)', () => {
    const d = derive({
      hasRealObjective: true,
      acRealTotal: 3,
      acRealChecked: 3,
      acAllChecked: true,
      planApproved: true,
      implementationStarted: true,
    })!;
    expect(d.phase).toBe('review');
  });

  it('REGRESSION: approval invalidated mid-build drops phase back', () => {
    const before = derive({ hasRealObjective: true, acRealTotal: 3, planExists: true, planApproved: true, implementationStarted: true })!;
    expect(before.phase).toBe('in_progress');
    // replan → planApproved false (digest mismatch) — ladder re-evaluates lower
    const after = derive({ hasRealObjective: true, acRealTotal: 3, planExists: true, planApproved: false, implementationStarted: true })!;
    expect(after.phase).toBe('ready_for_planning');
  });
});

describe('deriveDimensions — disposition orthogonality', () => {
  it('blocked never erases phase', () => {
    const d = derive({ hasRealObjective: true, acRealTotal: 3, planApproved: true, blocked: true })!;
    expect(d.phase).toBe('ready_to_implement'); // phase preserved
    expect(d.disposition).toBe('blocked');
    expect(d.status).toBe('blocked'); // headline shows disposition
    expect(d.derivedStatus).toBe('blocked');
  });

  it('parked beats blocked (first match)', () => {
    const d = derive({ parked: true, blocked: true })!;
    expect(d.disposition).toBe('parked');
  });

  it('parked without a parked status definition falls back to phase headline', () => {
    const d = derive({ hasRealObjective: true, acRealTotal: 3, parked: true })!;
    expect(d.disposition).toBe('parked');
    expect(d.status).toBe('ready_for_planning'); // KNOWN has no 'parked' id
  });
});

describe('deriveDimensions — terminal + override', () => {
  it('terminal assignments defer entirely', () => {
    expect(derive({}, { currentStatus: 'completed' })).toBeNull();
    expect(derive({}, { currentStatus: 'failed' })).toBeNull();
  });

  it('override folds into effective status; derivedStatus keeps the truth', () => {
    const d = derive(
      { hasRealObjective: true, acRealTotal: 3, planApproved: true },
      { override: { status: 'in_progress', source: 'human', reason: 'forcing it', at: '2026-06-09T12:00:00Z' } },
    )!;
    expect(d.status).toBe('in_progress'); // pinned
    expect(d.derivedStatus).toBe('ready_to_implement'); // would-otherwise-be
  });

  it('terminal/unknown override targets are ignored (defense in depth)', () => {
    const t = derive({}, { override: { status: 'completed', source: 'human', reason: null, at: '' } })!;
    expect(t.status).toBe('draft');
    const u = derive({}, { override: { status: 'no_such_status', source: 'human', reason: null, at: '' } })!;
    expect(u.status).toBe('draft');
  });
});

describe('derive conditions are facts-only (time has no teeth here)', () => {
  it('accepts fact conditions', () => {
    expect(validateDeriveCondition('planApproved:true AND acRealTotal > 0')).toBeNull();
    expect(validateDeriveCondition('*')).toBeNull();
  });
  it('rejects time-based and identity fields', () => {
    expect(validateDeriveCondition('statusAge > 3d')).toContain('Unknown field');
    expect(validateDeriveCondition('created > -36h')).toContain('Unknown field');
    expect(validateDeriveCondition('status:draft')).toContain('Unknown field');
  });
});

// ── fact computation (Node-side) ───────────────────────────────────────────

const tmpDirs: string[] = [];
afterAll(async () => {
  await Promise.all(tmpDirs.map((d) => rm(d, { recursive: true, force: true })));
});

async function makeAssignmentDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'syntaur-derive-'));
  tmpDirs.push(dir);
  return dir;
}

const TEMPLATE_BODY = `
# Test

## Objective

<!-- Clear description of what needs to be done and why. -->

## Acceptance Criteria

- [ ] <!-- criterion 1 -->
- [ ] <!-- criterion 2 -->
- [ ] <!-- criterion 3 -->

## Context
`;

const REAL_BODY = `
# Test

## Objective

Ship the derived status engine.

## Acceptance Criteria

- [x] Engine derives phases
- [x] Disposition is orthogonal
- [ ] Dashboard shows divergence

## Context
`;

describe('fact computation', () => {
  it('template placeholders do not count (the every-draft-promotes bug)', () => {
    expect(hasRealObjective(TEMPLATE_BODY)).toBe(false);
    expect(countRealAcceptanceCriteria(TEMPLATE_BODY)).toEqual({ total: 0, checked: 0 });
  });

  it('real content counts', () => {
    expect(hasRealObjective(REAL_BODY)).toBe(true);
    expect(countRealAcceptanceCriteria(REAL_BODY)).toEqual({ total: 3, checked: 2 });
  });

  it('latestPlanFile picks the highest revision', async () => {
    const dir = await makeAssignmentDir();
    expect(await latestPlanFile(dir)).toBeNull();
    await writeFile(join(dir, 'plan.md'), '# plan');
    expect(await latestPlanFile(dir)).toBe('plan.md');
    await writeFile(join(dir, 'plan-v2.md'), '# plan v2');
    await writeFile(join(dir, 'plan-v10.md'), '# plan v10');
    expect(await latestPlanFile(dir)).toBe('plan-v10.md');
  });

  it('isPlanApproved is revision-bound: replan or edit invalidates', async () => {
    const dir = await makeAssignmentDir();
    const planContent = '# The plan\n\n1. do it\n';
    await writeFile(join(dir, 'plan.md'), planContent);
    const approval = { file: 'plan.md', digest: planDigest(planContent), by: 'human', at: '' };

    expect(await isPlanApproved(dir, { planApproval: approval })).toBe(true);
    // edit the approved plan → digest mismatch
    await writeFile(join(dir, 'plan.md'), planContent + '\n2. do more\n');
    expect(await isPlanApproved(dir, { planApproval: approval })).toBe(false);
    // restore content, then replan → file no longer latest
    await writeFile(join(dir, 'plan.md'), planContent);
    expect(await isPlanApproved(dir, { planApproval: approval })).toBe(true);
    await writeFile(join(dir, 'plan-v2.md'), '# new plan');
    expect(await isPlanApproved(dir, { planApproval: approval })).toBe(false);
  });

  it('computeFacts end-to-end on a real-looking assignment', async () => {
    const dir = await makeAssignmentDir();
    const planContent = '# The plan';
    await writeFile(join(dir, 'plan.md'), planContent);
    const fm = `---
id: x
slug: x
title: "X"
status: in_progress
priority: medium
created: "2026-06-09T10:00:00Z"
updated: "2026-06-09T10:00:00Z"
assignee: claude
externalIds: []
dependsOn: []
links: []
blockedReason: "waiting on vendor"
workspace:
  repository: /repo
  worktreePath: null
  branch: feat/x
  parentBranch: main
tags: []
implementationStarted: true
planApproval:
  file: plan.md
  digest: ${planDigest(planContent)}
  by: human
  at: "2026-06-09T11:00:00Z"
---
${REAL_BODY}`;
    await writeFile(join(dir, 'assignment.md'), fm);
    const frontmatter = parseAssignmentFrontmatter(fm);
    const facts = await computeFacts({
      assignmentDir: dir,
      frontmatter,
      body: REAL_BODY,
      projectDir: null,
      terminalStatuses: TERMINALS,
    });
    expect(facts).toMatchObject({
      hasRealObjective: true,
      acRealTotal: 3,
      acRealChecked: 2,
      acAllChecked: false,
      planExists: true,
      planApproved: true,
      workspaceSet: true,
      implementationStarted: true,
      blocked: true,
      parked: false,
      pinned: false,
      depsSatisfied: true,
    });

    // and the full pipeline: facts → dimensions
    const d = deriveDimensions({
      facts,
      derive: DEFAULT_DERIVE_CONFIG,
      currentStatus: frontmatter.status,
      terminalStatuses: TERMINALS,
      knownStatusIds: KNOWN,
      override: frontmatter.override,
    })!;
    expect(d.phase).toBe('in_progress');
    expect(d.disposition).toBe('blocked');
    expect(d.status).toBe('blocked');
  });
});
