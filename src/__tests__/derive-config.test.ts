import { describe, it, expect } from 'vitest';
import {
  DEFAULT_DERIVE_CONFIG,
  parseStatusConfig,
  serializeStatusConfig,
  validateDeriveConfig,
  validateDeriveShape,
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

describe('validateDeriveConfig — disposition else-arm ordering (P1-3)', () => {
  const statuses = { statuses: [{ id: 'a' }, { id: 'parked' }, { id: 'blocked' }] };
  const headline = { terminal: 'passthrough' as const, parked: 'parked', blocked: 'blocked', active: 'phase' as const };
  const ladder = [{ phase: 'a', when: '*' }];

  it('accepts exactly one else-arm at the last index', () => {
    const problems = validateDeriveConfig(
      { phaseLadder: ladder, disposition: [{ when: 'blocked:true', is: 'blocked' }, { when: null, is: 'active' }], headline },
      statuses,
    );
    expect(problems).toEqual([]);
  });

  it('rejects an else-FIRST config (later rules unreachable)', () => {
    const problems = validateDeriveConfig(
      { phaseLadder: ladder, disposition: [{ when: null, is: 'active' }, { when: 'blocked:true', is: 'blocked' }], headline },
      statuses,
    );
    expect(problems.some((p) => p.includes('LAST'))).toBe(true);
  });

  it('rejects a duplicate else-arm', () => {
    const problems = validateDeriveConfig(
      { phaseLadder: ladder, disposition: [{ when: null, is: 'active' }, { when: null, is: 'parked' }], headline },
      statuses,
    );
    expect(problems.some((p) => p.includes('exactly one'))).toBe(true);
  });
});

describe('validateDeriveShape — deep shape-check (P1-2)', () => {
  const headline = { parked: 'a', blocked: 'b' };

  it('returns no problems for a well-formed payload', () => {
    expect(
      validateDeriveShape({ phaseLadder: [{ phase: 'a', when: '*', next: 'x' }], disposition: [{ when: null, is: 'active' }], headline }),
    ).toEqual([]);
  });

  it('flags a null rung', () => {
    const problems = validateDeriveShape({ phaseLadder: [null], disposition: [], headline });
    expect(problems.some((p) => p.includes('phaseLadder[0]'))).toBe(true);
  });

  it('flags a non-string when', () => {
    const problems = validateDeriveShape({ phaseLadder: [{ phase: 'a', when: 5 }], disposition: [], headline });
    expect(problems.some((p) => p.includes('when must be a string'))).toBe(true);
  });

  it('flags a non-string next', () => {
    const problems = validateDeriveShape({ phaseLadder: [{ phase: 'a', when: '*', next: 7 }], disposition: [], headline });
    expect(problems.some((p) => p.includes('next must be a string'))).toBe(true);
  });

  it('flags non-array phaseLadder / disposition and bad headline', () => {
    expect(validateDeriveShape({ phaseLadder: {}, disposition: [], headline }).some((p) => p.includes('phaseLadder must be an array'))).toBe(true);
    expect(validateDeriveShape({ phaseLadder: [], disposition: 'x', headline }).some((p) => p.includes('disposition must be an array'))).toBe(true);
    expect(validateDeriveShape({ phaseLadder: [], disposition: [], headline: { parked: 1, blocked: 'b' } }).some((p) => p.includes('headline.parked'))).toBe(true);
  });
});

// AC4: serializeStatusConfig escapes "→\" for when/next/disposition-when, but
// the paired unquote never reversed it, so an AQL condition containing a quote
// accumulated a backslash on every save→reload. Serialize/parse must be
// symmetric (escape \ then ", reverse both on read).
describe('derive config round-trips quoted AQL conditions (AC4)', () => {
  function roundTrip(cfg: StatusConfig): StatusConfig {
    return parseStatusConfig(`---\n${serializeStatusConfig(cfg)}\n---\n`)!;
  }

  it('preserves a phaseLadder when containing a double-quoted literal across repeated round-trips', () => {
    const cfg = parseStatusConfig(CONFIG_WITH_DERIVE)!;
    cfg.derive!.phaseLadder[0] = { phase: 'draft', when: 'title = "needs review"', next: 'do it' };
    const once = roundTrip(cfg);
    expect(once.derive!.phaseLadder[0].when).toBe('title = "needs review"');
    // The accumulation guard: a SECOND round-trip must still be byte-stable.
    const twice = roundTrip(once);
    expect(twice.derive!.phaseLadder[0].when).toBe('title = "needs review"');
    expect(twice.derive!.phaseLadder[0].next).toBe('do it');
  });

  it('preserves a disposition when containing quotes', () => {
    const cfg = parseStatusConfig(CONFIG_WITH_DERIVE)!;
    cfg.derive!.disposition[0] = { when: 'label = "p1"', is: 'parked' };
    const twice = roundTrip(roundTrip(cfg));
    expect(twice.derive!.disposition[0]).toEqual({ when: 'label = "p1"', is: 'parked' });
  });

  it('preserves a when containing a literal backslash (full escape symmetry)', () => {
    const cfg = parseStatusConfig(CONFIG_WITH_DERIVE)!;
    cfg.derive!.phaseLadder[0] = { phase: 'draft', when: 'note = "a\\b"', next: 'x' };
    const twice = roundTrip(roundTrip(cfg));
    expect(twice.derive!.phaseLadder[0].when).toBe('note = "a\\b"');
  });

  it('does not over-decode fields the serializer never escapes (facts/is/headline)', () => {
    // Regression guard for the scoped fix: plain ids must be untouched.
    const cfg = parseStatusConfig(CONFIG_WITH_DERIVE)!;
    const twice = roundTrip(roundTrip(cfg));
    expect(twice.derive!.disposition).toEqual(cfg.derive!.disposition);
    expect(twice.derive!.headline).toEqual(cfg.derive!.headline);
  });
});
