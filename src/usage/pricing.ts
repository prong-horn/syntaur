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
  // Z.ai (Zhipu) GLM-5.2 — official z.ai platform list price.
  // source: https://docs.z.ai/guides/overview/pricing — cross-checked
  //         https://openrouter.ai/z-ai/glm-5 (retrieved 2026-06-18)
  'zai-org/glm-5.2': { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 1.4 },
  // MiniMax M2.5 — official MiniMax platform list price. No separately-pinned
  // cached-read rate is published, so cacheRead is set conservatively to the
  // input rate (upper bound); revise if MiniMax publishes a cache rate.
  // source: https://platform.minimax.io/docs/guides/pricing-token-plan
  //         — cross-checked https://openrouter.ai/minimax/minimax-m2.5 (retrieved 2026-06-18)
  'minimaxai/minimax-m2.5': { input: 0.15, output: 0.9, cacheRead: 0.15, cacheWrite: 0.15 },
  // NOTE: opaque Synthetic tier aliases like `syn:large:text` have no public
  // per-token rate (they route to whatever Synthetic assigns), so they remain
  // unpriced (→ $0). Reseller discounts (e.g. DeepInfra K2.6 0.75/3.50/0.15) are
  // rejected by the canonical-source rule and are NOT used here.
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
