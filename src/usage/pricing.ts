/**
 * Token×model cost fallback for usage events that the upstream collector
 * (ccusage) cannot price.
 *
 * Background: Syntaur passes ccusage's per-model `cost` straight through. ccusage
 * prices the mainstream Anthropic/OpenAI models (claude/codex) from its bundled
 * pricing data, but has NO price for some agents' models — notably pi's
 * Synthetic-hosted models, which it reports as `"[pi] hf:moonshotai/Kimi-K2.6"`
 * with `cost: 0`. This module supplies a Syntaur-side fallback that computes
 * `tokens × the model's list rate` for exactly those models.
 *
 * Canonical pricing-source rule:
 *   A rate is the MODEL ORIGINATOR's official published API list price (e.g.
 *   Moonshot for Kimi), cross-checked against OpenRouter's listed rate for the
 *   same model. Reseller/aggregator *discounts* (DeepInfra, Synthetic, Together,
 *   …) are deliberately NOT used — the displayed cost is a provider-/
 *   subscription-agnostic REFERENCE list-price estimate (the same basis ccusage
 *   gives claude/codex), not what any one customer actually pays. When sources
 *   disagree, the originator's official price wins; if the originator publishes
 *   no price, the model is OMITTED here (→ unknown → $0) rather than guessed.
 *
 * This table contains ONLY models ccusage cannot price. It must never list a
 * model ccusage already prices (claude/codex), so the fallback can never inflate
 * a legitimately-zero claude/codex row.
 */

/** USD per *million* tokens, per token bucket. Divided by 1e6 at use. */
export interface ModelRate {
  input: number;
  output: number;
  /** Cached-input (cache *read*) rate — typically far below the input rate. */
  cacheRead: number;
  /** Cache creation (write) rate — priced at the input rate absent a clearer figure. */
  cacheWrite: number;
}

/** Token counts as surfaced by ccusage's per-model breakdown. */
export interface TokenBuckets {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
}

const PER_MILLION = 1_000_000;

/**
 * Normalized-model-id → list rate. Keys are the output of {@link normalizeModelKey}.
 * Add a row (with a sourced comment) to price a new model.
 */
export const MODEL_PRICING: Record<string, ModelRate> = {
  // Moonshot Kimi K2.6 — the model pi emits today. Official Moonshot list price.
  // source: https://platform.moonshot.ai/ (official) — cross-checked
  //         https://openrouter.ai/moonshotai/kimi-k2.6 (retrieved 2026-06-17)
  'moonshotai/kimi-k2.6': { input: 0.95, output: 4.0, cacheRead: 0.16, cacheWrite: 0.95 },
  // Moonshot Kimi K2.5 — prior Kimi model. Official Moonshot list price.
  // source: https://platform.moonshot.ai/ — cross-checked
  //         https://openrouter.ai/moonshotai/kimi-k2.5 (retrieved 2026-06-17)
  'moonshotai/kimi-k2.5': { input: 0.6, output: 3.0, cacheRead: 0.1, cacheWrite: 0.6 },
  // NOTE: minimaxai/minimax-m2.5 is intentionally OMITTED — no cleanly-pinned
  // originator list price, and pi volume is ~1% (~1M tok). Per the rule above it
  // degrades to $0 (same as today, no regression). Add once an official rate is
  // pinned. Reseller discounts (e.g. DeepInfra K2.6 0.75/3.50/0.15) are rejected
  // by the canonical-source rule and are NOT used here.
};

/**
 * Canonicalize a model string into a `MODEL_PRICING` key. Strips a leading
 * `"[agent] "` bracket prefix (ccusage namespaces non-native agents this way,
 * e.g. `"[pi] hf:moonshotai/Kimi-K2.6"`) and an `hf:` provider prefix, then
 * lowercases. Pure and total — never throws.
 */
export function normalizeModelKey(model: string): string {
  return model
    .replace(/^\s*\[[^\]]*\]\s*/, '') // drop a leading "[pi] " style prefix
    .replace(/^hf:/i, '') // drop a HuggingFace-style provider prefix
    .trim()
    .toLowerCase();
}

/**
 * Compute the fallback cost (USD) for a usage row from its token buckets and the
 * model's list rate. Returns `null` when the model is not in {@link MODEL_PRICING}
 * — callers keep the existing cost (0) in that case. A known model with zero
 * tokens returns 0.
 */
export function priceForModel(model: string, tokens: TokenBuckets): number | null {
  const rate = MODEL_PRICING[normalizeModelKey(model)];
  if (!rate) return null;
  return (
    (tokens.inputTokens * rate.input +
      tokens.outputTokens * rate.output +
      tokens.cacheReadTokens * rate.cacheRead +
      tokens.cacheCreationTokens * rate.cacheWrite) /
    PER_MILLION
  );
}
