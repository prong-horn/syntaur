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

  it('returns null for an unknown model (excluded MiniMax, and any claude/codex model)', () => {
    expect(
      priceForModel('[pi] hf:MiniMaxAI/MiniMax-M2.5', {
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
