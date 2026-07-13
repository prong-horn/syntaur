import { describe, expect, it } from 'vitest';
import {
  parseAssignmentFrontmatter,
  appendStatusHistoryEntry,
  replaceSolicitations,
  replaceFiredVerdicts,
  replaceGateOverrides,
  writeFrozenChecks,
  updateAssignmentFile,
} from '../lifecycle/frontmatter.js';
import type {
  Solicitation,
  GateOverride,
  FrozenCheck,
  StatusHistoryEntry,
} from '../lifecycle/types.js';

const BASE = `---
id: abc
slug: t
title: Test
project: p
type: feature
workflow: null
status: in_progress
priority: medium
created: "2026-07-09T00:00:00Z"
updated: "2026-07-09T00:00:00Z"
assignee: null
externalIds: []
statusHistory: []
dependsOn: []
links: []
blockedReason: null
tags: []
archived: false
---

# Test
`;

describe('WS-2 stage-engine frontmatter blocks', () => {
  it('defaults are sane when the blocks are absent', () => {
    const fm = parseAssignmentFrontmatter(BASE);
    expect(fm.solicitations).toEqual([]);
    expect(fm.firedVerdicts).toEqual([]);
    expect(fm.frozenChecks).toBeNull();
    expect(fm.hold).toBe(false);
    expect(fm.gateOverrides).toEqual([]);
  });

  it('round-trips solicitations', () => {
    const list: Solicitation[] = [
      { check: 'codeReviewed', judge: 'kimi', revisionBinding: 'abc123', at: '2026-07-09T01:00:00Z', state: 'solicited' },
      { check: 'planApproved', at: '2026-07-09T02:00:00Z', state: 'rendered' },
    ];
    const written = replaceSolicitations(BASE, list);
    expect(parseAssignmentFrontmatter(written).solicitations).toEqual(list);
  });

  it('round-trips firedVerdicts (colon-bearing dissent keys)', () => {
    const keys = ['codeReviewed:alice:2026-07-09T03:00:00Z:deadbeef', 'planApproved:bob:2026-07-09T04:00:00Z:none'];
    const written = replaceFiredVerdicts(BASE, keys);
    expect(parseAssignmentFrontmatter(written).firedVerdicts).toEqual(keys);
  });

  it('round-trips frozenChecks: null / [] / list', () => {
    expect(parseAssignmentFrontmatter(writeFrozenChecks(BASE, null)).frozenChecks).toBeNull();
    expect(parseAssignmentFrontmatter(writeFrozenChecks(BASE, [])).frozenChecks).toEqual([]);
    const checks: FrozenCheck[] = [
      { key: 'reviewing:0', label: 'codeReviewed', passed: true },
      { key: 'reviewing:1', label: 'acsChecked', passed: false },
    ];
    expect(parseAssignmentFrontmatter(writeFrozenChecks(BASE, checks)).frozenChecks).toEqual(checks);
  });

  it('round-trips hold via the scalar whitelist', () => {
    const written = updateAssignmentFile(BASE, { hold: true });
    expect(parseAssignmentFrontmatter(written).hold).toBe(true);
    const cleared = updateAssignmentFile(written, { hold: false });
    expect(parseAssignmentFrontmatter(cleared).hold).toBe(false);
  });

  it('round-trips gateOverrides', () => {
    const overrides: GateOverride[] = [
      {
        stage: 'reviewing',
        key: 'reviewing:0',
        label: 'codeReviewed',
        from: 'reviewing',
        to: 'done',
        actor: 'human',
        at: '2026-07-09T05:00:00Z',
        reason: 'shipping hotfix',
      },
    ];
    const written = replaceGateOverrides(BASE, overrides);
    expect(parseAssignmentFrontmatter(written).gateOverrides).toEqual(overrides);
  });

  it('round-trips a full engine hop statusHistory entry', () => {
    const entry: StatusHistoryEntry = {
      at: '2026-07-09T06:00:00Z',
      from: 'building',
      to: 'reviewing',
      command: 'recompute',
      by: 'system',
      trigger: 'gate',
      route: { to: 'reviewing', on: 'gate' },
      gateSnapshot: [{ key: 'building:0', label: 'acsChecked', passed: true }],
      dissent: { key: 'codeReviewed:alice:2026-07-09T05:00:00Z:abc', check: 'codeReviewed', actor: 'alice', verdict: 'changes-requested', note: 'fix the thing' },
    };
    const written = appendStatusHistoryEntry(BASE, entry);
    const parsed = parseAssignmentFrontmatter(written).statusHistory;
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toEqual(entry);
  });

  it('leaves a flat ladder statusHistory entry unchanged (no hop fields)', () => {
    const entry: StatusHistoryEntry = {
      at: '2026-07-09T07:00:00Z',
      from: 'draft',
      to: 'ready_for_planning',
      command: 'shape',
      by: 'human',
    };
    const written = appendStatusHistoryEntry(BASE, entry);
    // No hop-field keys were serialized.
    expect(written).not.toMatch(/trigger:|route:|gateSnapshot:|dissent:/);
    const parsed = parseAssignmentFrontmatter(written).statusHistory[0];
    expect(parsed).toEqual(entry);
    expect(parsed.trigger).toBeUndefined();
    expect(parsed.route).toBeUndefined();
  });
});
