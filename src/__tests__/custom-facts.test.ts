import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile, readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  parseStatusConfig,
  serializeStatusConfig,
  normalizeFactDeclarations,
  validateFactDeclarations,
  validateDeriveConfig,
  DEFAULT_DERIVE_CONFIG,
  type RawFactDeclaration,
  type StatusConfig,
} from '../utils/config.js';
import {
  factFieldNames,
  acceptFactDeclarations,
  buildDeriveRegistry,
  buildQueryRegistry,
  validateDeriveCondition,
} from '../lifecycle/derive.js';
import { compileQuery } from '../utils/query/index.js';
import {
  computeFactsDetailed,
  canonicalizeFactValue,
} from '../lifecycle/facts.js';
import {
  parseAssignmentFrontmatter,
  updateFactsMap,
  upsertAttestation,
} from '../lifecycle/frontmatter.js';
import { parseAssignmentFull } from '../dashboard/parser.js';
import {
  recomputeAndWrite,
  type DeriveContext,
} from '../lifecycle/recompute.js';
import { deriveConfigChecks } from '../utils/doctor/checks/derive-config.js';
import { getAssignmentDetail, clearStatusConfigCache } from '../dashboard/api.js';
import type { AssignmentFrontmatter, AttestationRecord } from '../lifecycle/types.js';

// ── helpers ──────────────────────────────────────────────────────────────────

const STATUS_BLOCK = `statuses:
  definitions:
    - id: draft
      label: Draft
    - id: ready_for_planning
      label: Ready for Planning
    - id: shipped
      label: Shipped
  order:
    - draft
    - ready_for_planning
    - shipped
  facts:
    - name: qaPassed
      type: bool
    - name: storyPoints
      type: number
    - name: codeReview
      type: attestation
      binds: plan
    - name: deploy
      type: attestation
      binds: commit
    - name: signoff
      type: attestation
      binds: none`;

function configContent(extra = ''): string {
  return `---\nversion: "2.0"\ndefaultProjectDir: /tmp/x\n${STATUS_BLOCK}\n${extra}---\n`;
}

// ── Task 1/2: config parse / serialize / preserve ────────────────────────────

describe('statuses.facts config parse + serialize', () => {
  it('parses bool / number / attestation (each binds) declarations', () => {
    const cfg = parseStatusConfig(configContent());
    expect(cfg).not.toBeNull();
    expect(cfg!.facts).toEqual([
      { name: 'qaPassed', type: 'bool', binds: null },
      { name: 'storyPoints', type: 'number', binds: null },
      { name: 'codeReview', type: 'attestation', binds: 'plan' },
      { name: 'deploy', type: 'attestation', binds: 'commit' },
      { name: 'signoff', type: 'attestation', binds: 'none' },
    ]);
  });

  it('round-trips through serialize → parse, preserving a malformed row verbatim', () => {
    const cfg = parseStatusConfig(configContent());
    // inject a malformed raw row (bad type) — must survive serialization verbatim
    cfg!.facts!.push({ name: 'weird', type: 'frobnicate', binds: null });
    const serialized = serializeStatusConfig(cfg!);
    const reparsed = parseStatusConfig(`---\nversion: "2.0"\n${serialized}\n---\n`);
    expect(reparsed!.facts).toContainEqual({ name: 'weird', type: 'frobnicate', binds: null });
    expect(reparsed!.facts).toContainEqual({ name: 'codeReview', type: 'attestation', binds: 'plan' });
  });

  it('emits no facts: block when there are no declarations', () => {
    const cfg: StatusConfig = {
      statuses: [{ id: 'draft', label: 'Draft' }],
      order: ['draft'],
      transitions: [],
    };
    expect(serializeStatusConfig(cfg)).not.toContain('facts:');
  });

  it('preserves a malformed row missing `name` verbatim (round-trips; validate flags it)', () => {
    const cfg = parseStatusConfig(configContent().replace(/\n---\n$/, '\n    - type: bool\n---\n'));
    expect(cfg!.facts).toContainEqual({ name: '', type: 'bool', binds: null });
    // round-trips through serialize → parse (no silent deletion on the next write)
    const reparsed = parseStatusConfig(`---\nversion: "2.0"\n${serializeStatusConfig(cfg!)}\n---\n`);
    expect(reparsed!.facts).toContainEqual({ name: '', type: 'bool', binds: null });
    // and doctor can diagnose it
    expect(validateFactDeclarations(cfg!.facts!).join(' ')).toMatch(/invalid name/i);
  });
});

describe('normalizeFactDeclarations', () => {
  it('narrows valid rows and DROPS malformed ones without throwing', () => {
    const raw: RawFactDeclaration[] = [
      { name: 'qaPassed', type: 'bool', binds: null },
      { name: 'pts', type: 'number', binds: null },
      { name: 'rev', type: 'attestation', binds: 'plan' },
      { name: 'attNoBinds', type: 'attestation', binds: null }, // defaults to none
      { name: 'badType', type: 'frobnicate', binds: null }, // dropped
      { name: 'Bad-Name', type: 'bool', binds: null }, // dropped (name format)
      { name: 'badBinds', type: 'attestation', binds: 'yesterday' }, // dropped
    ];
    expect(normalizeFactDeclarations(raw)).toEqual([
      { name: 'qaPassed', type: 'bool' },
      { name: 'pts', type: 'number' },
      { name: 'rev', type: 'attestation', binds: 'plan' },
      { name: 'attNoBinds', type: 'attestation', binds: 'none' },
    ]);
    expect(normalizeFactDeclarations(null)).toEqual([]);
  });
});

// ── Task 3: registry / naming / collision ────────────────────────────────────

describe('factFieldNames + registries', () => {
  it('bool/number export only <name>; attestation exports all five', () => {
    expect(factFieldNames({ name: 'qaPassed', type: 'bool' }).registryKeys).toEqual(['qapassed']);
    const att = factFieldNames({ name: 'codeReview', type: 'attestation', binds: 'plan' });
    expect(att.exports).toEqual({
      fact: 'codeReview',
      approved: 'codeReviewApproved',
      changesRequested: 'codeReviewChangesRequested',
      by: 'codeReviewBy',
      approvedBy: 'codeReviewApprovedBy',
    });
    expect(att.registryKeys).toEqual([
      'codereview',
      'codereviewapproved',
      'codereviewchangesrequested',
      'codereviewby',
      'codereviewapprovedby',
    ]);
  });

  it('buildDeriveRegistry adds the five attestation fields (by/approvedBy as list)', () => {
    const reg = buildDeriveRegistry([{ name: 'codeReview', type: 'attestation', binds: 'plan' }]);
    expect(reg['codereview'].kind).toBe('bool');
    expect(reg['codereviewapproved'].kind).toBe('bool');
    expect(reg['codereviewchangesrequested'].kind).toBe('bool');
    expect(reg['codereviewby'].kind).toBe('list');
    expect(reg['codereviewapprovedby'].kind).toBe('list');
    // base fields intact
    expect(reg['planapproved'].kind).toBe('bool');
  });
});

describe('acceptFactDeclarations collision filter', () => {
  it('drops a declaration colliding with a built-in (attestation named plan → planApproved)', () => {
    const accepted = acceptFactDeclarations(
      normalizeFactDeclarations([
        { name: 'plan', type: 'attestation', binds: 'plan' }, // generates planApproved → collides
        { name: 'qaPassed', type: 'bool', binds: null },
      ]),
    );
    expect(accepted.map((d) => d.name)).toEqual(['qaPassed']); // plan dropped, built-ins intact
    // and the built-in registry is untouched by the build
    const reg = buildDeriveRegistry(accepted);
    expect(reg['planapproved'].kind).toBe('bool'); // still the built-in
  });

  it('first-declared wins among duplicate exported keys', () => {
    const accepted = acceptFactDeclarations(
      normalizeFactDeclarations([
        { name: 'dup', type: 'bool', binds: null },
        { name: 'dup', type: 'number', binds: null },
      ]),
    );
    expect(accepted).toEqual([{ name: 'dup', type: 'bool' }]);
  });
});

// ── Task 3/4: validation ─────────────────────────────────────────────────────

describe('validateFactDeclarations', () => {
  it('accepts clean declarations', () => {
    expect(
      validateFactDeclarations([
        { name: 'qaPassed', type: 'bool', binds: null },
        { name: 'codeReview', type: 'attestation', binds: 'plan' },
      ]),
    ).toEqual([]);
  });

  it('rejects a generated-name collision with a built-in (attestation named plan)', () => {
    const problems = validateFactDeclarations([{ name: 'plan', type: 'attestation', binds: 'plan' }]);
    expect(problems.join(' ')).toMatch(/planapproved.*collides with a built-in/i);
  });

  it('rejects a collision with ASSIGNMENT_FIELDS (e.g. tags)', () => {
    const problems = validateFactDeclarations([{ name: 'tags', type: 'bool', binds: null }]);
    expect(problems.join(' ')).toMatch(/collides with a built-in/i);
  });

  it('rejects bad name, bad type, bad binds', () => {
    expect(validateFactDeclarations([{ name: 'Bad-Name', type: 'bool', binds: null }]).join(' ')).toMatch(
      /invalid name/i,
    );
    expect(validateFactDeclarations([{ name: 'x', type: 'frob', binds: null }]).join(' ')).toMatch(
      /invalid type/i,
    );
    expect(
      validateFactDeclarations([{ name: 'x', type: 'attestation', binds: 'never' }]).join(' '),
    ).toMatch(/invalid binds/i);
  });

  it('flags two declarations whose exported keys collide with each other', () => {
    const problems = validateFactDeclarations([
      { name: 'rev', type: 'attestation', binds: 'plan' },
      { name: 'revApproved', type: 'bool', binds: null }, // collides with rev's revApproved
    ]);
    expect(problems.join(' ')).toMatch(/collides with fact "rev"/i);
  });

  it('flags a same-name duplicate (matches the runtime accept-filter, which drops it)', () => {
    const problems = validateFactDeclarations([
      { name: 'dup', type: 'bool', binds: null },
      { name: 'dup', type: 'number', binds: null },
    ]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/duplicate declaration/i);
  });

  it('a built-in-collided declaration reserves nothing — a later valid declaration is not falsely flagged', () => {
    // `plan` (attestation) is dropped at runtime for the planApproved collision;
    // its other generated keys (planBy, …) must NOT poison `planBy` (bool), which
    // the runtime accepts. Validation must agree with acceptFactDeclarations.
    const rows: RawFactDeclaration[] = [
      { name: 'plan', type: 'attestation', binds: 'plan' },
      { name: 'planBy', type: 'bool', binds: null },
    ];
    const problems = validateFactDeclarations(rows);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/planapproved.*built-in/i); // only the plan/built-in collision
    expect(acceptFactDeclarations(normalizeFactDeclarations(rows)).map((d) => d.name)).toEqual(['planBy']);
  });
});

describe('validateDeriveConfig with the dynamic registry', () => {
  const statusConfig = { statuses: [{ id: 'draft', label: 'Draft' }, { id: 'shipped', label: 'Shipped' }] };

  it('rejects a rung referencing an UNDECLARED fact name', () => {
    const derive = {
      ...DEFAULT_DERIVE_CONFIG,
      phaseLadder: [
        { phase: 'draft', when: '*' },
        { phase: 'shipped', when: 'qaPassed:true' },
      ],
      headline: { terminal: 'passthrough' as const, parked: 'draft', blocked: 'draft', active: 'phase' as const },
    };
    // base registry → qaPassed unknown
    const base = validateDeriveConfig(derive, statusConfig, (w) => validateDeriveCondition(w));
    expect(base.join(' ')).toMatch(/qaPassed|Unknown field/i);
    // dynamic registry with qaPassed declared → passes
    const reg = buildDeriveRegistry([{ name: 'qaPassed', type: 'bool' }]);
    const dyn = validateDeriveConfig(derive, statusConfig, (w) => validateDeriveCondition(w, reg));
    expect(dyn).toEqual([]);
  });

  it('validateDeriveCondition still rejects time/undeclared fields with a custom registry', () => {
    const reg = buildDeriveRegistry([{ name: 'qaPassed', type: 'bool' }]);
    expect(validateDeriveCondition('qaPassed:true', reg)).toBeNull();
    expect(validateDeriveCondition('statusAge > 3d', reg)).not.toBeNull();
    expect(validateDeriveCondition('undeclaredFact:true', reg)).not.toBeNull();
  });
});

// ── Task 6/8: AQL over custom + attestation fields ───────────────────────────

describe('AQL queries over custom + attestation registry', () => {
  const reg = buildQueryRegistry(
    normalizeFactDeclarations([
      { name: 'qaPassed', type: 'bool', binds: null },
      { name: 'codeReview', type: 'attestation', binds: 'plan' },
    ]),
  );
  const item = {
    qaPassed: true,
    codeReview: true,
    codeReviewApproved: true,
    codeReviewApprovedBy: ['agent:codex'],
    codeReviewBy: ['agent:codex', 'human'],
  };

  function run(q: string): boolean {
    const { query, errors } = compileQuery(q, reg);
    if (!query) throw new Error(`parse failed: ${errors.map((e) => e.message).join(', ')}`);
    return query.predicate(item, { now: 0 });
  }

  it('bool custom fact + attestation bool export', () => {
    expect(run('qaPassed:true')).toBe(true);
    expect(run('codeReviewApproved:true')).toBe(true);
    expect(run('codeReviewChangesRequested:true')).toBe(false);
  });

  it('actor list: quoted `:` equality (contains) and IN-list', () => {
    expect(run('codeReviewApprovedBy:"agent:codex"')).toBe(true);
    expect(run('codeReviewApprovedBy:"agent:nobody"')).toBe(false);
    expect(run('codeReviewBy:("agent:codex", "agent:other")')).toBe(true); // IN, contains
  });

  it('field names are case-insensitive in AQL', () => {
    expect(run('CodeReviewApprovedBy:"agent:codex"')).toBe(true);
    expect(run('QAPASSED:true')).toBe(true);
  });
});

// ── Task 6: coercion ─────────────────────────────────────────────────────────

describe('canonicalizeFactValue', () => {
  it('bool: case-insensitive true/false only', () => {
    expect(canonicalizeFactValue('bool', ' TRUE ')).toBe('true');
    expect(canonicalizeFactValue('bool', 'False')).toBe('false');
    expect(canonicalizeFactValue('bool', 'yes')).toBeNull();
  });
  it('number: finite only (rejects NaN/Infinity/empty)', () => {
    expect(canonicalizeFactValue('number', ' 5 ')).toBe('5');
    expect(canonicalizeFactValue('number', '3.14')).toBe('3.14');
    expect(canonicalizeFactValue('number', '')).toBeNull();
    expect(canonicalizeFactValue('number', 'NaN')).toBeNull();
    expect(canonicalizeFactValue('number', 'Infinity')).toBeNull();
    expect(canonicalizeFactValue('number', 'abc')).toBeNull();
  });
});

// ── Task 5/6: frontmatter round-trip + materialization on disk ───────────────

const BASE_FM = `---
id: t-id
slug: t
title: "T"
project: p
status: in_progress
priority: medium
created: "2026-06-09T10:00:00Z"
updated: "2026-06-09T10:00:00Z"
assignee: null
externalIds: []
dependsOn: []
links: []
blockedReason: null
workspace:
  repository: null
  worktreePath: null
  branch: null
  parentBranch: null
tags: []
phase: in_progress
disposition: active
parked: false
reviewRequested: false
implementationStarted: true
override: null
---

# T

## Objective

Real.

## Acceptance Criteria

- [ ] one
`;

describe('frontmatter facts/attestations round-trip + writers', () => {
  it('updateFactsMap writes a facts: map that round-trips', () => {
    let content = updateFactsMap(BASE_FM, 'qaPassed', 'true');
    content = updateFactsMap(content, 'storyPoints', '5');
    const fm = parseAssignmentFrontmatter(content);
    expect(fm.facts).toEqual({ qaPassed: 'true', storyPoints: '5' });
  });

  it('upsertAttestation replaces the same (fact, actor) record', () => {
    const r1: AttestationRecord = { fact: 'codeReview', actor: 'agent:codex', verdict: 'changes-requested', at: 't1', file: 'plan.md', digest: 'd1' };
    const r2: AttestationRecord = { fact: 'codeReview', actor: 'agent:codex', verdict: 'approved', at: 't2', file: 'plan.md', digest: 'd2' };
    const r3: AttestationRecord = { fact: 'codeReview', actor: 'human', verdict: 'approved', at: 't3', file: 'plan.md', digest: 'd2' };
    let content = upsertAttestation(BASE_FM, r1);
    content = upsertAttestation(content, r2); // replaces r1
    content = upsertAttestation(content, r3); // new actor
    const fm = parseAssignmentFrontmatter(content);
    expect(fm.attestations).toHaveLength(2);
    const codex = fm.attestations.find((a) => a.actor === 'agent:codex')!;
    expect(codex.verdict).toBe('approved');
    expect(codex.at).toBe('t2');
  });

  it('lifecycle and dashboard parsers agree on facts/attestations (parity)', () => {
    let content = updateFactsMap(BASE_FM, 'qaPassed', 'true');
    content = upsertAttestation(content, {
      fact: 'codeReview', actor: 'agent:codex', verdict: 'approved', at: 't', file: 'plan.md', digest: 'd',
    });
    const lifecycle = parseAssignmentFrontmatter(content);
    const dashboard = parseAssignmentFull(content);
    expect(dashboard.facts).toEqual(lifecycle.facts);
    expect(dashboard.attestations).toEqual(lifecycle.attestations);
  });

  it('parsers agree on ESCAPED values (note with quotes + backslash)', () => {
    const note = 'fix the "lock" and the \\path';
    const content = upsertAttestation(BASE_FM, {
      fact: 'codeReview', actor: 'agent:codex', verdict: 'changes-requested', at: 't',
      file: 'plan.md', digest: 'd', note,
    });
    const lifecycle = parseAssignmentFrontmatter(content);
    const dashboard = parseAssignmentFull(content);
    expect(lifecycle.attestations[0].note).toBe(note); // round-trips through formatYamlValue escaping
    expect(dashboard.attestations).toEqual(lifecycle.attestations); // dashboard unescapes identically
  });

  it('upsertAttestation replaces a scalar `attestations: null` without duplicating the key', () => {
    const withNull = BASE_FM.replace('override: null', 'override: null\nattestations: null');
    const out = upsertAttestation(withNull, { fact: 'codeReview', actor: 'a', verdict: 'approved', at: 't' });
    expect((out.match(/^attestations:/gm) ?? []).length).toBe(1); // no duplicate key
    expect(parseAssignmentFrontmatter(out).attestations).toHaveLength(1);
  });
});

describe('computeFactsDetailed: custom + attestation materialization', () => {
  let dir: string;
  const decls = normalizeFactDeclarations([
    { name: 'qaPassed', type: 'bool', binds: null },
    { name: 'storyPoints', type: 'number', binds: null },
    { name: 'codeReview', type: 'attestation', binds: 'plan' },
    { name: 'signoff', type: 'attestation', binds: 'none' },
    { name: 'deploy', type: 'attestation', binds: 'commit' },
  ]);

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'syntaur-facts-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function compute(fm: AssignmentFrontmatter) {
    return computeFactsDetailed({
      assignmentDir: dir,
      frontmatter: fm,
      body: '## Objective\nReal.\n## Acceptance Criteria\n- [ ] one\n',
      projectDir: null,
      terminalStatuses: new Set(['completed', 'failed']),
      declarations: decls,
    });
  }

  it('coerces stored bool/number; invalid/absent degrade to false/0', async () => {
    let content = updateFactsMap(BASE_FM, 'qaPassed', 'true');
    content = updateFactsMap(content, 'storyPoints', 'garbage'); // invalid → 0
    const fm = parseAssignmentFrontmatter(content);
    const { facts } = await compute(fm);
    expect(facts.qaPassed).toBe(true);
    expect(facts.storyPoints).toBe(0);
  });

  it('binds:plan validity flips false on plan edit and on replan (plan-v2)', async () => {
    const { createHash } = await import('node:crypto');
    await writeFile(join(dir, 'plan.md'), '# Plan v1');
    const digest = createHash('sha256').update('# Plan v1', 'utf-8').digest('hex');
    let content = upsertAttestation(BASE_FM, {
      fact: 'codeReview', actor: 'agent:codex', verdict: 'approved', at: 't', file: 'plan.md', digest,
    });
    let fm = parseAssignmentFrontmatter(content);

    // valid now
    let res = await compute(fm);
    expect(res.facts.codeReview).toBe(true);
    expect(res.facts.codeReviewApproved).toBe(true);
    expect(res.facts.codeReviewApprovedBy).toEqual(['agent:codex']);
    expect(res.attestations.find((a) => a.fact === 'codeReview')!.records[0].valid).toBe(true);

    // edit plan → digest mismatch → stale
    await writeFile(join(dir, 'plan.md'), '# Plan v1 EDITED');
    res = await compute(fm);
    expect(res.facts.codeReview).toBe(false);
    expect(res.facts.codeReviewApprovedBy).toEqual([]); // actor drops out when stale

    // replan: latest becomes plan-v2 → record.file (plan.md) no longer latest
    await writeFile(join(dir, 'plan.md'), '# Plan v1'); // restore digest match
    await writeFile(join(dir, 'plan-v2.md'), '# Plan v2');
    res = await compute(fm);
    expect(res.facts.codeReview).toBe(false);
  });

  it('binds:none never stales; changes-requested splits the exports', async () => {
    let content = upsertAttestation(BASE_FM, {
      fact: 'signoff', actor: 'human', verdict: 'changes-requested', at: 't',
    });
    const fm = parseAssignmentFrontmatter(content);
    const { facts } = await compute(fm);
    expect(facts.signoff).toBe(true); // any valid record
    expect(facts.signoffApproved).toBe(false);
    expect(facts.signoffChangesRequested).toBe(true);
    expect(facts.signoffBy).toEqual(['human']);
    expect(facts.signoffApprovedBy).toEqual([]);
  });

  it('binds:commit with no workspace path → headSha null → record invalid', async () => {
    let content = upsertAttestation(BASE_FM, {
      fact: 'deploy', actor: 'agent:ci', verdict: 'approved', at: 't', commit: 'abc123',
    });
    const fm = parseAssignmentFrontmatter(content); // workspace paths are null in BASE_FM
    const { facts } = await compute(fm);
    expect(facts.deploy).toBe(false);
  });
});

// ── Decision 4 / AC9: opt-in audit entry on dimension-stable mutations ────────

describe('recomputeAndWrite auditMutation flag (Decision 4)', () => {
  let dir: string;
  let path: string;
  // A draft with no real objective derives to `draft` under DEFAULT_DERIVE_CONFIG
  // — already converged, so a fact mutation on a no-rung fact is dimension-stable.
  const CONVERGED = `---
id: a
slug: a
title: "A"
project: null
status: draft
priority: medium
created: "2026-06-09T10:00:00Z"
updated: "2026-06-09T10:00:00Z"
assignee: null
externalIds: []
statusHistory: []
dependsOn: []
links: []
blockedReason: null
workspace:
  repository: null
  worktreePath: null
  branch: null
  parentBranch: null
tags: []
phase: draft
disposition: active
parked: false
reviewRequested: false
implementationStarted: false
override: null
---

# A

## Objective

<!-- placeholder -->
`;

  const extra = normalizeFactDeclarations([{ name: 'extra', type: 'bool', binds: null }]);
  const context: DeriveContext = {
    derive: DEFAULT_DERIVE_CONFIG,
    terminalStatuses: new Set(['completed', 'failed']),
    knownStatusIds: new Set(['draft', 'ready_for_planning', 'ready_to_implement', 'in_progress', 'review', 'blocked']),
    factDeclarations: extra,
    registry: buildDeriveRegistry(extra),
  };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'syntaur-audit-'));
    path = join(dir, 'assignment.md');
    await writeFile(path, CONVERGED);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('WITHOUT auditMutation: a dimension-stable mutation writes no history entry (existing behavior)', async () => {
    const r = await recomputeAndWrite(path, {
      cause: 'plan-approve',
      by: 'human',
      projectDir: null,
      context,
      mutate: (c) => updateFactsMap(c, 'extra', 'true'),
    });
    expect(r.changed).toBe(true); // the fact still landed
    const fm = parseAssignmentFrontmatter(await readFile(path, 'utf-8'));
    expect(fm.facts.extra).toBe('true');
    expect(fm.statusHistory).toHaveLength(0); // but no audit entry
  });

  it('WITH auditMutation: a dimension-stable mutation appends a same-status entry', async () => {
    const r = await recomputeAndWrite(path, {
      cause: 'fact-set',
      by: 'agent:codex',
      projectDir: null,
      context,
      auditMutation: true,
      mutate: (c) => updateFactsMap(c, 'extra', 'true'),
    });
    expect(r.changed).toBe(true);
    const fm = parseAssignmentFrontmatter(await readFile(path, 'utf-8'));
    expect(fm.statusHistory).toHaveLength(1);
    expect(fm.statusHistory[0]).toMatchObject({
      command: 'fact-set',
      by: 'agent:codex',
      from: 'draft',
      to: 'draft',
    });
    expect(fm.statusHistory[0].phaseFrom).toBeUndefined();
  });
});

// ── Task 4: doctor check ─────────────────────────────────────────────────────

describe('doctor derive-config check', () => {
  const [check] = deriveConfigChecks;

  function ctxWith(statuses: unknown) {
    return { config: { statuses } } as unknown as Parameters<typeof check.run>[0];
  }

  it('skips when no facts or derive rules are configured', async () => {
    const res = (await check.run(ctxWith(null))) as { status: string };
    expect(res.status).toBe('skipped');
  });

  it('errors on a colliding fact declaration (validates with derive: null)', async () => {
    const res = (await check.run(
      ctxWith({
        statuses: [{ id: 'draft', label: 'Draft' }],
        order: ['draft'],
        transitions: [],
        derive: null,
        facts: [{ name: 'plan', type: 'attestation', binds: 'plan' }], // planApproved collision
      }),
    )) as { status: string; detail?: string };
    expect(res.status).toBe('error');
    expect(res.detail).toMatch(/collides with a built-in/i);
  });

  it('passes on clean facts + a rung that references a declared fact', async () => {
    const res = (await check.run(
      ctxWith({
        statuses: [{ id: 'draft', label: 'Draft' }, { id: 'shipped', label: 'Shipped' }],
        order: ['draft', 'shipped'],
        transitions: [],
        facts: [{ name: 'qaPassed', type: 'bool', binds: null }],
        derive: {
          phaseLadder: [
            { phase: 'draft', when: '*' },
            { phase: 'shipped', when: 'qaPassed:true' },
          ],
          disposition: [{ when: null, is: 'active' }],
          headline: { terminal: 'passthrough', parked: 'draft', blocked: 'draft', active: 'phase' },
        },
      }),
    )) as { status: string };
    expect(res.status).toBe('pass');
  });
});

// ── Task 8/9: dashboard detail payload ───────────────────────────────────────

describe('dashboard getAssignmentDetail derived payload', () => {
  let home: string;
  let prevHome: string | undefined;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'syntaur-dash-'));
    prevHome = process.env.SYNTAUR_HOME;
    process.env.SYNTAUR_HOME = home;
    clearStatusConfigCache();
    await writeFile(resolve(home, 'config.md'), configContent());
    const aDir = resolve(home, 'projects', 'p1', 'assignments', 'feat-x');
    await mkdir(aDir, { recursive: true });
    await writeFile(resolve(home, 'projects', 'p1', 'project.md'), '---\nslug: p1\n---\n# P1\n');
    await writeFile(resolve(aDir, 'plan.md'), '# Plan');

    const { createHash } = await import('node:crypto');
    const digest = createHash('sha256').update('# Plan', 'utf-8').digest('hex');
    let content = `---
id: feat-x
slug: feat-x
title: "Feat X"
project: p1
status: in_progress
priority: medium
created: "2026-06-09T10:00:00Z"
updated: "2026-06-09T10:00:00Z"
assignee: null
externalIds: []
statusHistory: []
dependsOn: []
links: []
blockedReason: null
workspace:
  repository: null
  worktreePath: null
  branch: null
  parentBranch: null
tags: []
phase: in_progress
disposition: active
parked: false
reviewRequested: false
implementationStarted: true
override: null
---

# Feat X

## Objective

Real.

## Acceptance Criteria

- [ ] one
`;
    content = updateFactsMap(content, 'qaPassed', 'true');
    content = updateFactsMap(content, 'storyPoints', '8');
    // one valid (digest matches), and after we'll check a stale path separately
    content = upsertAttestation(content, {
      fact: 'codeReview', actor: 'agent:codex', verdict: 'approved', at: 't', file: 'plan.md', digest,
    });
    content = upsertAttestation(content, {
      fact: 'codeReview', actor: 'human', verdict: 'changes-requested', at: 't', file: 'plan.md', digest: 'STALEDIGEST',
    });
    await writeFile(resolve(aDir, 'assignment.md'), content);
  });

  afterEach(async () => {
    if (prevHome === undefined) delete process.env.SYNTAUR_HOME;
    else process.env.SYNTAUR_HOME = prevHome;
    clearStatusConfigCache();
    await rm(home, { recursive: true, force: true });
  });

  it('ships customFacts (bool/number only) + attestation records with stale flags', async () => {
    const detail = await getAssignmentDetail(resolve(home, 'projects'), 'p1', 'feat-x');
    expect(detail).not.toBeNull();
    const derived = detail!.derived!;
    expect(derived).not.toBeNull();
    // customFacts contains declared bool/number only — no attestation exports, no built-ins
    expect(derived.customFacts).toEqual({ qaPassed: true, storyPoints: 8 });
    // attestation records carry per-actor verdict + staleness
    const cr = derived.attestations.find((a) => a.fact === 'codeReview')!;
    expect(cr.binds).toBe('plan');
    const codex = cr.records.find((r) => r.actor === 'agent:codex')!;
    const human = cr.records.find((r) => r.actor === 'human')!;
    expect(codex.stale).toBe(false);
    expect(codex.verdict).toBe('approved');
    expect(human.stale).toBe(true); // digest mismatch
    // the full fact set carries the attestation exports too
    expect(derived.facts.codeReviewApproved).toBe(true);
    expect(derived.facts.codeReviewApprovedBy).toEqual(['agent:codex']);
  });

  it('returns derived: null for a terminal assignment (guard intact)', async () => {
    const aPath = resolve(home, 'projects', 'p1', 'assignments', 'feat-x', 'assignment.md');
    const raw = await readFile(aPath, 'utf-8');
    await writeFile(aPath, raw.replace('status: in_progress', 'status: completed'));
    const detail = await getAssignmentDetail(resolve(home, 'projects'), 'p1', 'feat-x');
    expect(detail!.derived).toBeNull();
  });
});
