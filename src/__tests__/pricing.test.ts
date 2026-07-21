import { describe, it, expect } from 'vitest';
import { normalizeModelKey, priceForModel, MODEL_PRICING } from '../usage/pricing.js';

describe('normalizeModelKey', () => {
  it('strips a [agent] bracket prefix and an hf: provider prefix, then lowercases', () => {
    expect(normalizeModelKey('[pi] hf:moonshotai/Kimi-K2.6')).toBe('moonshotai/kimi-k2.6');
  });

  it('handles a bare hf: prefix with no bracket', () => {
    expect(normalizeModelKey('hf:moonshotai/Kimi-K2.5')).toBe('moonshotai/kimi-k2.5');
  });

  it('leaves an already-normalized key unchanged', () => {
    expect(normalizeModelKey('moonshotai/kimi-k2.6')).toBe('moonshotai/kimi-k2.6');
  });
});

describe('priceForModel', () => {
  it('prices a known model and charges cacheRead at the cheap cached rate (not the input rate)', () => {
    // K2.6 per million: in 0.95, out 4.00, cacheRead 0.16, cacheWrite 0.95.
    const cost = priceForModel('[pi] hf:moonshotai/Kimi-K2.6', {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheCreationTokens: 0,
      cacheReadTokens: 1_000_000,
    });
    expect(cost).toBeCloseTo(0.95 + 4.0 + 0.16, 10); // 5.11
  });

  it('charges a cache-heavy mix far below the input rate (the pi-typical case)', () => {
    const cost = priceForModel('[pi] hf:moonshotai/Kimi-K2.6', {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 10_000_000,
    });
    // 10M cacheRead @ $0.16/M = $1.60 — vs $9.50 if it were wrongly charged at input rate.
    expect(cost).toBeCloseTo(1.6, 10);
  });

  it('prices the GLM-5.2 and MiniMax M2.5 pi models (input/output buckets)', () => {
    // GLM-5.2: in 1.40, out 4.40 per million.
    expect(
      priceForModel('[pi] hf:zai-org/GLM-5.2', {
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
      }),
    ).toBeCloseTo(1.4 + 4.4, 10);
    // MiniMax M2.5: official pay-as-you-go in 0.30, out 1.20 per million.
    expect(
      priceForModel('[pi] hf:MiniMaxAI/MiniMax-M2.5', {
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
      }),
    ).toBeCloseTo(0.3 + 1.2, 10);
  });

  it('returns null for an unknown model (opaque Synthetic alias, any claude/codex model)', () => {
    expect(
      priceForModel('[pi] syn:large:text', {
        inputTokens: 1000,
        outputTokens: 1000,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
      }),
    ).toBeNull();
    expect(
      priceForModel('claude-opus-4-8', {
        inputTokens: 1000,
        outputTokens: 1000,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
      }),
    ).toBeNull();
  });

  it('returns 0 for a known model with zero tokens', () => {
    expect(
      priceForModel('moonshotai/kimi-k2.6', {
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
      }),
    ).toBe(0);
  });

  it('contains ONLY models ccusage cannot price — never a claude/codex model (anti-inflation guard)', () => {
    for (const key of Object.keys(MODEL_PRICING)) {
      expect(key).not.toMatch(/claude|gpt|codex/i);
    }
  });
});

describe('MODEL_ALIASES coverage of live model strings', () => {
  /**
   * Every distinct model string observed on zero-cost rows in the real usage DB
   * (2026-07-18). These are the strings the serve-time fallback must price, and
   * the reason `MODEL_ALIASES` exists: most do not normalize to a pricing key on
   * their own.
   *
   * `syn:large:text` is the ONE deliberate exception — an opaque Synthetic tier
   * alias with no public per-token rate, left unpriced per the module's
   * canonical-source rule rather than guessed.
   */
  const LIVE_MODEL_STRINGS = [
    '[pi] kimi-k2.6',
    '[pi] hf:zai-org/GLM-5.1',
    '[pi] glm-5.2',
    '[pi] z-ai/glm-5.2',
    '[pi] moonshotai/kimi-k2.7-code',
  ];
  const EXPECTED_UNPRICED = ['[pi] syn:large:text'];

  it.each(LIVE_MODEL_STRINGS)('prices %s', (model) => {
    const cost = priceForModel(model, {
      inputTokens: 1_000_000,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
    });
    expect(cost).not.toBeNull();
    expect(cost).toBeGreaterThan(0);
  });

  it.each(EXPECTED_UNPRICED)('leaves %s unpriced by design', (model) => {
    expect(
      priceForModel(model, {
        inputTokens: 1_000_000,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
      }),
    ).toBeNull();
  });

  it('resolves org-less and alternate-org spellings to one canonical key', () => {
    expect(normalizeModelKey('[pi] glm-5.2')).toBe('zai-org/glm-5.2');
    expect(normalizeModelKey('[pi] z-ai/glm-5.2')).toBe('zai-org/glm-5.2');
    expect(normalizeModelKey('[pi] hf:zai-org/GLM-5.2')).toBe('zai-org/glm-5.2');
    expect(normalizeModelKey('kimi-k2.6')).toBe('moonshotai/kimi-k2.6');
  });

  it('leaves an unknown model string untouched', () => {
    expect(normalizeModelKey('[pi] syn:large:text')).toBe('syn:large:text');
  });

  it('prices MiniMax M2.5 with all four token buckets at the official rate', () => {
    // Official MiniMax pay-as-you-go: 0.30 in / 1.20 out / 0.03 cache-read /
    // 0.375 cache-write per 1M tokens. Exercise each bucket independently.
    const rate = (bucket: 'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheCreationTokens') =>
      priceForModel('[pi] minimax-m2.5', {
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        [bucket]: 1_000_000,
      } as Parameters<typeof priceForModel>[1]);
    expect(rate('inputTokens')).toBeCloseTo(0.3, 6);
    expect(rate('outputTokens')).toBeCloseTo(1.2, 6);
    expect(rate('cacheReadTokens')).toBeCloseTo(0.03, 6);
    expect(rate('cacheCreationTokens')).toBeCloseTo(0.375, 6);
  });
});
