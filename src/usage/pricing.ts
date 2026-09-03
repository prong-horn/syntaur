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
 * This table lists models whose usage reaches Syntaur UNPRICED. Historically
 * that meant only pi's Synthetic-hosted models; since phase 4 it also means the
 * OpenAI models the assignment chat's `codex-acp` adapter reports, because that
 * usage never passes through ccusage at all — the broker prices it here itself
 * (Decision 10). Anthropic models are still absent: ccusage prices every claude
 * row, and the broker takes claude's own cumulative `usage_update.cost`.
 *
 * Adding the OpenAI rows cannot inflate a ccusage codex row: the collector's
 * fallback fires only when the reported cost is 0, and a codex row that ccusage
 * legitimately costed at zero has zero token buckets, which price to zero here
 * too.
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
  // Moonshot Kimi K2.7 Code — official Moonshot list price ($0.95 in / $4.00 out,
  // $0.19 cache-hit input). OpenRouter lists 0.72/3.50 for the same model, i.e. a
  // routed-provider rate BELOW the originator's list; per the canonical-source
  // rule above the originator's price wins and the aggregator discount is not used.
  // source: https://platform.moonshot.ai/ (official) — cross-checked
  //         https://openrouter.ai/moonshotai/kimi-k2.7-code (retrieved 2026-07-19)
  'moonshotai/kimi-k2.7-code': { input: 0.95, output: 4.0, cacheRead: 0.19, cacheWrite: 0.95 },
  // Z.ai (Zhipu) GLM-5.2 — official z.ai platform list price.
  // source: https://docs.z.ai/guides/overview/pricing — cross-checked
  //         https://openrouter.ai/z-ai/glm-5 (retrieved 2026-06-18)
  'zai-org/glm-5.2': { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 1.4 },
  // Z.ai (Zhipu) GLM-5.1 — prior GLM model, still present in historical usage
  // rows. Official z.ai list price is identical to GLM-5.2's.
  // source: https://docs.z.ai/guides/overview/pricing (official, retrieved
  //         2026-07-19) — cross-checked https://openrouter.ai/z-ai/glm-5.1,
  //         which lists 0.966/3.036 marked "31% off" (= 69% of 1.4/4.4),
  //         confirming 1.4/4.4 as list. The discount is rejected per the
  //         canonical-source rule above.
  'zai-org/glm-5.1': { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 1.4 },
  // MiniMax M2.5 — official MiniMax pay-as-you-go list price, incl. the
  // separately-published prompt-caching read/write rates.
  // source: https://platform.minimax.io/docs/guides/pricing-paygo (official,
  //         retrieved 2026-07-21): input $0.30, output $1.20, cache read $0.03,
  //         cache write $0.375 per 1M tokens.
  'minimaxai/minimax-m2.5': { input: 0.3, output: 1.2, cacheRead: 0.03, cacheWrite: 0.375 },
  // --- OpenAI GPT-5.x, for the assignment chat's `codex-acp` sessions -------
  //
  // The adapter reports a bare model id on the session's `model` config option
  // (`gpt-5.6-sol` / `gpt-5.6-terra` in the captured fixtures) and no cost of
  // its own, so without these every codex chat turn books at $0.
  //
  // `cacheWrite` is set to the input rate throughout: OpenAI's prompt caching is
  // automatic and publishes no separate write rate, only the discounted
  // cached-input read rate, so cache-creation tokens bill as ordinary input.
  //
  // source: https://developers.openai.com/api/docs/pricing (official, retrieved
  //         2026-09-03). Third-party trackers list Sol at $5.00/$30.00; per the
  //         canonical-source rule above the originator's page wins.
  'gpt-5.6-sol': { input: 4.0, output: 20.0, cacheRead: 0.4, cacheWrite: 4.0 },
  'gpt-5.6-terra': { input: 2.0, output: 12.0, cacheRead: 0.2, cacheWrite: 2.0 },
  'gpt-5.6-luna': { input: 0.2, output: 1.2, cacheRead: 0.02, cacheWrite: 0.2 },
  // The <272K-context tier for the models that publish two; codex sessions run
  // well inside it.
  'gpt-5.5': { input: 5.0, output: 30.0, cacheRead: 0.5, cacheWrite: 5.0 },
  'gpt-5.5-pro': { input: 30.0, output: 180.0, cacheRead: 30.0, cacheWrite: 30.0 },
  'gpt-5.4': { input: 2.5, output: 15.0, cacheRead: 0.25, cacheWrite: 2.5 },
  'gpt-5.4-mini': { input: 0.75, output: 4.5, cacheRead: 0.075, cacheWrite: 0.75 },
  'gpt-5.4-nano': { input: 0.2, output: 1.25, cacheRead: 0.02, cacheWrite: 0.2 },
  'gpt-5.4-pro': { input: 30.0, output: 180.0, cacheRead: 30.0, cacheWrite: 30.0 },
  'gpt-5.2': { input: 1.75, output: 14.0, cacheRead: 0.175, cacheWrite: 1.75 },
  'gpt-5.1': { input: 1.25, output: 10.0, cacheRead: 0.125, cacheWrite: 1.25 },
  'gpt-5': { input: 1.25, output: 10.0, cacheRead: 0.125, cacheWrite: 1.25 },
  'gpt-5-mini': { input: 0.25, output: 2.0, cacheRead: 0.025, cacheWrite: 0.25 },
  'gpt-5-nano': { input: 0.05, output: 0.4, cacheRead: 0.005, cacheWrite: 0.05 },
  // NOTE: opaque Synthetic tier aliases like `syn:large:text` have no public
  // per-token rate (they route to whatever Synthetic assigns), so they remain
  // unpriced (→ $0). Reseller discounts (e.g. DeepInfra K2.6 0.75/3.50/0.15) are
  // rejected by the canonical-source rule and are NOT used here.
  //
  // The `-pro` tiers publish no cached-input rate ("—"), so their `cacheRead`
  // is the input rate: an unpublished discount is never assumed.
};

/**
 * Variant model strings → canonical `MODEL_PRICING` key.
 *
 * Agents report the same model under several spellings: org-less (`glm-5.2`),
 * a different org prefix (`z-ai/…` vs the HuggingFace `zai-org/…`), or a bare
 * family name. Without this map those rows normalize to a key that is not in
 * `MODEL_PRICING` and silently stay at $0. Keys and values are both in
 * post-strip lowercase form — i.e. what {@link normalizeModelKey} produces
 * before the alias lookup.
 */
export const MODEL_ALIASES: Record<string, string> = {
  'kimi-k2.6': 'moonshotai/kimi-k2.6',
  'kimi-k2.5': 'moonshotai/kimi-k2.5',
  'kimi-k2.7-code': 'moonshotai/kimi-k2.7-code',
  'glm-5.2': 'zai-org/glm-5.2',
  'z-ai/glm-5.2': 'zai-org/glm-5.2',
  'glm-5.1': 'zai-org/glm-5.1',
  'z-ai/glm-5.1': 'zai-org/glm-5.1',
  'minimax-m2.5': 'minimaxai/minimax-m2.5',
  'minimax/minimax-m2.5': 'minimaxai/minimax-m2.5',
};

/**
 * Canonicalize a model string into a `MODEL_PRICING` key. Strips a leading
 * `"[agent] "` bracket prefix (ccusage namespaces non-native agents this way,
 * e.g. `"[pi] hf:moonshotai/Kimi-K2.6"`) and an `hf:` provider prefix,
 * lowercases, then resolves any {@link MODEL_ALIASES} entry. Pure and total —
 * never throws.
 */
export function normalizeModelKey(model: string): string {
  const stripped = model
    .replace(/^\s*\[[^\]]*\]\s*/, '') // drop a leading "[pi] " style prefix
    .replace(/^hf:/i, '') // drop a HuggingFace-style provider prefix
    // drop pi's `opencode-go` provider prefix (incl. regional variants like
    // `opencode-go-tyler-eu/`) so `opencode-go/glm-5.2` resolves via the same
    // family aliases as the bare `glm-5.2`.
    .replace(/^opencode-go(?:-[a-z0-9-]+)?\//i, '')
    .replace(/\[[^\]]*\]$/, '') // drop cursor model suffixes like [thinking=true,…]
    .trim()
    .toLowerCase();
  return MODEL_ALIASES[stripped] ?? stripped;
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
