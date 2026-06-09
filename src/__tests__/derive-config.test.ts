import { describe, it, expect } from 'vitest';
import {
  DEFAULT_DERIVE_CONFIG,
  parseStatusConfig,
  serializeStatusConfig,
  validateDeriveConfig,
  type StatusConfig,
} from '../utils/config.js';
import { validateQuery } from '../utils/query/index.js';

const CONFIG_WITH_DERIVE = `---
version: "1.0"
statuses:
  definitions:
    - id: draft
      label: Draft
    - id: planning
      label: Planning
    - id: ready_to_implement
      label: Ready to Implement
    - id: in_progress
      label: In Progress
    - id: code_review
      label: Code Review
    - id: parked
      label: Parked
    - id: blocked
      label: Blocked
    - id: completed
      label: Completed
      terminal: true
  order:
    - draft
    - planning
    - ready_to_implement
    - in_progress
    - code_review
    - completed
  phaseLadder:
    - phase: draft
      when: "*"
      next: "Fill in the objective"
    - phase: planning
      when: "planExists:true"
      next: "Get the plan approved"
    - phase: ready_to_implement
      when: "planApproved:true"
      next: "Start implementing"
    - phase: code_review
      when: "acAllChecked:true OR reviewRequested:true"
  disposition:
    - when: "parked:true"
      is: parked
    - when: "blocked:true"
      is: blocked
    - else: active
  headline:
    terminal: passthrough
    parked: parked
    blocked: blocked
    active: phase
---

# Config
`;

describe('derive config parsing', () => {
  it('parses phaseLadder, disposition, and headline from config.md', () => {
    const cfg = parseStatusConfig(CONFIG_WITH_DERIVE);
    expect(cfg).not.toBeNull();
    expect(cfg!.derive).not.toBeNull();
    const d = cfg!.derive!;
    expect(d.phaseLadder).toHaveLength(4);
    expect(d.phaseLadder[0]).toEqual({ phase: 'draft', when: '*', next: 'Fill in the objective' });
    expect(d.phaseLadder[3].when).toBe('acAllChecked:true OR reviewRequested:true');
    expect(d.phaseLadder[3].next).toBeUndefined();
    expect(d.disposition).toEqual([
      { when: 'parked:true', is: 'parked' },
      { when: 'blocked:true', is: 'blocked' },
      { when: null, is: 'active' },
    ]);
    expect(d.headline.parked).toBe('parked');
  });

  it('derive is null when config has no derive sections (defaults resolve later)', () => {
    const minimal = CONFIG_WITH_DERIVE.split('  phaseLadder:')[0] + '---\n';
    const cfg = parseStatusConfig(minimal);
    expect(cfg).not.toBeNull();
    expect(cfg!.derive ?? null).toBeNull();
  });

  it('serialize → parse round-trips derive rules (writer preservation)', () => {
    const cfg = parseStatusConfig(CONFIG_WITH_DERIVE)!;
    const serialized = serializeStatusConfig(cfg);
    const reparsed = parseStatusConfig(`---\n${serialized}\n---\n`);
    expect(reparsed!.derive).toEqual(cfg.derive);
    // and the original sections survive too
    expect(reparsed!.statuses.map((s) => s.id)).toEqual(cfg.statuses.map((s) => s.id));
    expect(reparsed!.order).toEqual(cfg.order);
  });

  it('a Settings-style rewrite that spreads the parsed config keeps derive', () => {
    const cfg = parseStatusConfig(CONFIG_WITH_DERIVE)!;
    // simulate the api-status-config PUT: new defs/order/transitions + preserved derive
    const next: StatusConfig = {
      statuses: cfg.statuses,
      order: cfg.order,
      transitions: cfg.transitions,
      derive: cfg.derive ?? null,
    };
    const reparsed = parseStatusConfig(`---\n${serializeStatusConfig(next)}\n---\n`);
    expect(reparsed!.derive).toEqual(cfg.derive);
  });
});

describe('validateDeriveConfig', () => {
  const statusConfig = parseStatusConfig(CONFIG_WITH_DERIVE)!;
  const validateWhen = (w: string) => {
    const errs = validateQuery(w);
    return errs.length > 0 ? errs[0].message : null;
  };

  it('valid config has no problems', () => {
    expect(validateDeriveConfig(statusConfig.derive!, statusConfig, validateWhen)).toEqual([]);
  });

  it('default derive config validates against the default status set', () => {
    // 'parked' headline target is not in DEFAULT_STATUSES — exactly one expected warning
    const problems = validateDeriveConfig(
      DEFAULT_DERIVE_CONFIG,
      { statuses: ['draft', 'pending', 'ready_for_planning', 'ready_to_implement', 'in_progress', 'blocked', 'review', 'completed', 'failed'].map((id) => ({ id, label: id })) },
      validateWhen,
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('headline.parked');
  });

  it('flags unknown phase ids, bad conditions, bad dispositions, missing else', () => {
    const problems = validateDeriveConfig(
      {
        phaseLadder: [{ phase: 'nope', when: 'bogusfield:true' }],
        disposition: [{ when: 'blocked:true', is: 'frozen' }],
        headline: { terminal: 'passthrough', parked: 'parked', blocked: 'blocked', active: 'phase' },
      },
      statusConfig,
      validateWhen,
    );
    expect(problems.some((p) => p.includes('not a defined status id'))).toBe(true);
    expect(problems.some((p) => p.includes('invalid condition'))).toBe(true);
    expect(problems.some((p) => p.includes('frozen'))).toBe(true);
    expect(problems.some((p) => p.includes('else'))).toBe(true);
  });
});
