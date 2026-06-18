import { describe, expect, it } from 'vitest';
import {
  parseDurationMs,
  parseStalenessConfig,
  validateStalenessConfig,
} from '../utils/config.js';
import { resolveStaleThresholds, DEFAULT_STALE_THRESHOLDS } from '../staleness/classify.js';

const DAY = 86_400_000;

function cfg(block: string): string {
  return `---\nversion: "2.0"\n${block}\n---\n# C\n`;
}

describe('parseDurationMs', () => {
  it('parses unit suffixes', () => {
    expect(parseDurationMs('500ms')).toBe(500);
    expect(parseDurationMs('90s')).toBe(90_000);
    expect(parseDurationMs('30m')).toBe(1_800_000);
    expect(parseDurationMs('12h')).toBe(43_200_000);
    expect(parseDurationMs('7d')).toBe(7 * DAY);
  });
  it('treats a bare number as milliseconds', () => {
    expect(parseDurationMs('1000')).toBe(1000);
  });
  it('rejects malformed / non-positive', () => {
    expect(parseDurationMs('5x')).toBeNull();
    expect(parseDurationMs('')).toBeNull();
    expect(parseDurationMs('0')).toBeNull();
    expect(parseDurationMs('-3d')).toBeNull();
    expect(parseDurationMs('abc')).toBeNull();
  });
});

describe('parseStalenessConfig', () => {
  it('returns null when no staleness block', () => {
    expect(parseStalenessConfig(cfg('defaultProjectDir: /tmp/x'))).toBeNull();
  });

  it('parses known keys as durations into ms fields', () => {
    const parsed = parseStalenessConfig(
      cfg('staleness:\n  inProgressNoActivity: 14d\n  reviewAging: 2d'),
    );
    expect(parsed).toEqual({ inProgressNoActivityMs: 14 * DAY, reviewAgingMs: 2 * DAY });
  });

  it('drops unknown keys and malformed values (fail-safe)', () => {
    const parsed = parseStalenessConfig(
      cfg('staleness:\n  reviewAging: 2d\n  bogusKey: 9d\n  blockedAging: nope'),
    );
    expect(parsed).toEqual({ reviewAgingMs: 2 * DAY });
  });

  it('stops at the next dedented block', () => {
    const parsed = parseStalenessConfig(
      cfg('staleness:\n  reviewAging: 2d\ntheme:\n  preset: dark'),
    );
    expect(parsed).toEqual({ reviewAgingMs: 2 * DAY });
  });
});

describe('validateStalenessConfig', () => {
  it('no problems for a valid block', () => {
    expect(validateStalenessConfig(cfg('staleness:\n  reviewAging: 2d'))).toEqual([]);
  });
  it('flags unknown keys and bad durations', () => {
    const problems = validateStalenessConfig(
      cfg('staleness:\n  bogusKey: 9d\n  blockedAging: nope'),
    );
    expect(problems).toHaveLength(2);
    expect(problems[0]).toContain('bogusKey');
    expect(problems[1]).toContain('blockedAging');
  });
  it('empty when the block is absent', () => {
    expect(validateStalenessConfig(cfg('defaultProjectDir: /tmp/x'))).toEqual([]);
  });
});

describe('resolveStaleThresholds', () => {
  it('returns defaults for null/empty', () => {
    expect(resolveStaleThresholds(null)).toEqual(DEFAULT_STALE_THRESHOLDS);
    expect(resolveStaleThresholds(undefined)).toEqual(DEFAULT_STALE_THRESHOLDS);
  });
  it('merges overrides over defaults, keeping unspecified gates', () => {
    const merged = resolveStaleThresholds({ reviewAgingMs: 2 * DAY });
    expect(merged.reviewAgingMs).toBe(2 * DAY);
    expect(merged.blockedAgingMs).toBe(DEFAULT_STALE_THRESHOLDS.blockedAgingMs);
  });
  it('ignores non-positive / non-finite overrides defensively', () => {
    const merged = resolveStaleThresholds({ reviewAgingMs: -5, blockedAgingMs: Number.NaN });
    expect(merged.reviewAgingMs).toBe(DEFAULT_STALE_THRESHOLDS.reviewAgingMs);
    expect(merged.blockedAgingMs).toBe(DEFAULT_STALE_THRESHOLDS.blockedAgingMs);
  });
});
