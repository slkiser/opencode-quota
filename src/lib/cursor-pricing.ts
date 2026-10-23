import type { CostBuckets } from "./modelsdev-pricing.js";
import { getQuotaProviderRuntimeIds } from "./provider-metadata.js";

export type CursorQuotaPlan = "none" | "pro" | "pro-plus" | "ultra";

/** "unpriced": Cursor's own price, which no table here holds. */
type CursorResolvedModel =
  | { kind: "local"; model: CursorLocalPricingModel; pool: "auto_composer" }
  | { kind: "official"; providerHint: string; modelHint: string; pool: "api" }
  | { kind: "unpriced" }
  | { kind: "unknown" };

const CURSOR_INCLUDED_API_USD_BY_PLAN: Readonly<Record<Exclude<CursorQuotaPlan, "none">, number>> =
  {
    pro: 20,
    "pro-plus": 70,
    ultra: 400,
  };

const CURSOR_PROVIDER_IDS = new Set([
  ...getQuotaProviderRuntimeIds("cursor"),
  "open-cursor",
  "@rama_nigg/open-cursor",
]);

const CURSOR_LOCAL_PRICING = {
  auto: { input: 1.25, output: 6, cache_read: 0.25 },
  "composer-1": { input: 1.25, output: 10, cache_read: 0.125 },
  "composer-1.5": { input: 3.5, output: 17.5, cache_read: 0.35 },
  "composer-2": { input: 0.5, output: 2.5, cache_read: 0.2 },
  "composer-2-fast": { input: 1.5, output: 7.5, cache_read: 0.35 },
  "composer-2.5": { input: 0.5, output: 2.5, cache_read: 0.2 },
  "composer-2.5-fast": { input: 3, output: 15, cache_read: 0.5 },
  "grok-4.5": { input: 2, output: 6, cache_read: 0.5 },
  "grok-4.5-fast": { input: 4, output: 18, cache_read: 1 },
  "grok-4.6": { input: 2, output: 6, cache_read: 0.5 },
  "grok-4.6-fast": { input: 4, output: 12, cache_read: 1 },
  "grok-4.7": { input: 2, output: 6, cache_read: 0.5 },
  "grok-4.7-fast": { input: 4, output: 12, cache_read: 1 },
} satisfies Record<string, CostBuckets>;

type CursorLocalPricingModel = keyof typeof CURSOR_LOCAL_PRICING;

// Cursor bills a request of these models whose prompt passes 200k tokens at a long-context rate
// that no price here holds, so such a request has no price.
const CURSOR_LONG_CONTEXT_PROMPT_TOKENS = 200_000;
const CURSOR_MODELS_WITH_LONG_CONTEXT_RATE = new Set([
  "claude-sonnet-4",
  "gpt-5.4",
  "gpt-5.4-high",
  "gpt-5.4-medium",
  "gpt-5.5",
  "gpt-5.6-luna",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "grok-4.7",
  "grok-4.7-fast",
]);

// Cursor's price for these differs from models.dev's, or models.dev has none.
const CURSOR_MODELS_WITH_OWN_PRICE = new Set([
  "gemini-3.6-flash",
  "glm-5.3-flash",
  "muse-spark-1.3",
  "muse-wonder-1.0",
]);

// models.dev lists a cache-write rate for these that Cursor does not publish.
const CURSOR_MODELS_WITHOUT_CACHE_WRITE_RATE = new Set(["kimi-k3", "kimi-k3-1m"]);

export const CURSOR_OFFICIAL_MODEL_ALIASES: Readonly<
  Record<string, { providerHint: string; modelHint: string }>
> = {
  // `-1m` ids are the long-context entries of cursor-opencode-provider. Only models that
  // Cursor documents as 1M context "at the same per-token rates" map to the base price.
  "claude-4.5-sonnet": { providerHint: "anthropic", modelHint: "claude-sonnet-4-5" },
  "claude-4.6-opus-high": { providerHint: "anthropic", modelHint: "claude-opus-4-6" },
  "claude-4.6-opus": { providerHint: "anthropic", modelHint: "claude-opus-4-6" },
  "claude-4.6-sonnet-medium": { providerHint: "anthropic", modelHint: "claude-sonnet-4-6" },
  "claude-4.6-sonnet": { providerHint: "anthropic", modelHint: "claude-sonnet-4-6" },
  "claude-fable-5": { providerHint: "anthropic", modelHint: "claude-fable-5" },
  "claude-fable-5-1": { providerHint: "anthropic", modelHint: "claude-fable-5-1" },
  "claude-haiku-4-5": { providerHint: "anthropic", modelHint: "claude-haiku-4-5" },
  "claude-haiku-5-5": { providerHint: "anthropic", modelHint: "claude-haiku-5-5" },
  "claude-opus-4-5": { providerHint: "anthropic", modelHint: "claude-opus-4-5" },
  "claude-opus-4-6": { providerHint: "anthropic", modelHint: "claude-opus-4-6" },
  "claude-opus-4-6-1m": { providerHint: "anthropic", modelHint: "claude-opus-4-6" },
  "claude-opus-4-7": { providerHint: "anthropic", modelHint: "claude-opus-4-7" },
  "claude-opus-4-7-1m": { providerHint: "anthropic", modelHint: "claude-opus-4-7" },
  "claude-opus-4-8": { providerHint: "anthropic", modelHint: "claude-opus-4-8" },
  "claude-opus-4-8-1m": { providerHint: "anthropic", modelHint: "claude-opus-4-8" },
  "claude-opus-5": { providerHint: "anthropic", modelHint: "claude-opus-5" },
  "claude-opus-5-1m": { providerHint: "anthropic", modelHint: "claude-opus-5" },
  "claude-opus-5-5": { providerHint: "anthropic", modelHint: "claude-opus-5-5" },
  "claude-opus-5-5-1m": { providerHint: "anthropic", modelHint: "claude-opus-5-5" },
  "claude-sonnet-4": { providerHint: "anthropic", modelHint: "claude-sonnet-4-0" },
  "claude-sonnet-4-5": { providerHint: "anthropic", modelHint: "claude-sonnet-4-5" },
  "claude-sonnet-4-5-1m": { providerHint: "anthropic", modelHint: "claude-sonnet-4-5" },
  "claude-sonnet-4-6": { providerHint: "anthropic", modelHint: "claude-sonnet-4-6" },
  "claude-sonnet-4-6-1m": { providerHint: "anthropic", modelHint: "claude-sonnet-4-6" },
  "claude-sonnet-5": { providerHint: "anthropic", modelHint: "claude-sonnet-5" },
  "claude-sonnet-5-1m": { providerHint: "anthropic", modelHint: "claude-sonnet-5" },
  "claude-sonnet-5-5": { providerHint: "anthropic", modelHint: "claude-sonnet-5-5" },
  "claude-sonnet-5-5-1m": { providerHint: "anthropic", modelHint: "claude-sonnet-5-5" },
  "gemini-2.5-flash": { providerHint: "google", modelHint: "gemini-2.5-flash" },
  "gemini-3-flash": { providerHint: "google", modelHint: "gemini-3-flash-preview" },
  "gemini-3-pro": { providerHint: "google", modelHint: "gemini-3-pro-preview" },
  "gemini-3.1-pro": { providerHint: "google", modelHint: "gemini-3.1-pro-preview" },
  "gemini-3.5-flash": { providerHint: "google", modelHint: "gemini-3.5-flash" },
  "gemini-3.7-flash": { providerHint: "google", modelHint: "gemini-3.7-flash" },
  "gemini-3.8-flash": { providerHint: "google", modelHint: "gemini-3.8-flash" },
  "gemini-4-argon": { providerHint: "google", modelHint: "gemini-4-argon" },
  "glm-5.2": { providerHint: "zai", modelHint: "glm-5.2" },
  "glm-5.3": { providerHint: "zai", modelHint: "glm-5.3" },
  "gpt-5-mini": { providerHint: "openai", modelHint: "gpt-5-mini" },
  "gpt-5.1": { providerHint: "openai", modelHint: "gpt-5.1" },
  "gpt-5.2": { providerHint: "openai", modelHint: "gpt-5.2" },
  "gpt-5.2-codex": { providerHint: "openai", modelHint: "gpt-5.2-codex" },
  "gpt-5.3-codex": { providerHint: "openai", modelHint: "gpt-5.3-codex" },
  "gpt-5.3-codex-spark-preview": { providerHint: "openai", modelHint: "gpt-5.3-codex-spark" },
  "gpt-5.4": { providerHint: "openai", modelHint: "gpt-5.4" },
  "gpt-5.4-high": { providerHint: "openai", modelHint: "gpt-5.4" },
  "gpt-5.4-medium": { providerHint: "openai", modelHint: "gpt-5.4" },
  "gpt-5.4-mini": { providerHint: "openai", modelHint: "gpt-5.4-mini" },
  "gpt-5.4-nano": { providerHint: "openai", modelHint: "gpt-5.4-nano" },
  "gpt-5.5": { providerHint: "openai", modelHint: "gpt-5.5" },
  "gpt-5.6-luna": { providerHint: "openai", modelHint: "gpt-5.6-luna" },
  "gpt-5.6-sol": { providerHint: "openai", modelHint: "gpt-5.6-sol" },
  "gpt-5.6-terra": { providerHint: "openai", modelHint: "gpt-5.6-terra" },
  grok: { providerHint: "xai", modelHint: "grok-code-fast-1" },
  "grok-code-fast-1": { providerHint: "xai", modelHint: "grok-code-fast-1" },
  "kimi-k2.5": { providerHint: "moonshotai", modelHint: "kimi-k2.5" },
  "kimi-k2.7-code": { providerHint: "moonshotai", modelHint: "kimi-k2.7-code" },
  "kimi-k3": { providerHint: "moonshotai", modelHint: "kimi-k3" },
  "kimi-k3-1m": { providerHint: "moonshotai", modelHint: "kimi-k3" },
  "opus-4.5": { providerHint: "anthropic", modelHint: "claude-opus-4-5" },
  "opus-4.5-thinking": { providerHint: "anthropic", modelHint: "claude-opus-4-5" },
  "opus-4.6": { providerHint: "anthropic", modelHint: "claude-opus-4-6" },
  "opus-4.6-thinking": { providerHint: "anthropic", modelHint: "claude-opus-4-6" },
  "sonnet-4.5": { providerHint: "anthropic", modelHint: "claude-sonnet-4-5" },
  "sonnet-4.5-thinking": { providerHint: "anthropic", modelHint: "claude-sonnet-4-5" },
  "sonnet-4.6": { providerHint: "anthropic", modelHint: "claude-sonnet-4-6" },
  "sonnet-4.6-thinking": { providerHint: "anthropic", modelHint: "claude-sonnet-4-6" },
};

export function isCursorProviderId(raw?: string): boolean {
  if (!raw || typeof raw !== "string") return false;
  return CURSOR_PROVIDER_IDS.has(raw.trim().toLowerCase());
}

export function isCursorModelId(raw?: string): boolean {
  if (!raw || typeof raw !== "string") return false;
  const normalized = raw.trim().toLowerCase();
  return normalized.startsWith("cursor/") || normalized.startsWith("cursor-acp/");
}

const CURSOR_PLAN_NAMES: Readonly<Partial<Record<CursorQuotaPlan, string>>> = {
  pro: "Pro",
  "pro-plus": "Pro Plus",
  ultra: "Ultra",
};

export function getCursorPlanDisplayName(plan: CursorQuotaPlan): string | null {
  return CURSOR_PLAN_NAMES[plan] ?? null;
}

export function getEffectiveCursorIncludedApiUsd(params: {
  plan: CursorQuotaPlan;
  overrideUsd?: number;
}): number | undefined {
  if (
    typeof params.overrideUsd === "number" &&
    Number.isFinite(params.overrideUsd) &&
    params.overrideUsd >= 0
  ) {
    return params.overrideUsd;
  }
  return params.plan === "none" ? undefined : CURSOR_INCLUDED_API_USD_BY_PLAN[params.plan];
}

export function lookupCursorLocalCost(model: string): CostBuckets | null {
  return Object.hasOwn(CURSOR_LOCAL_PRICING, model)
    ? CURSOR_LOCAL_PRICING[model as CursorLocalPricingModel]
    : null;
}

/** Whether Cursor bills a request of `rawModelId` with `promptTokens` of prompt at base rates. */
export function cursorBaseRatesCoverPrompt(
  rawModelId: string | undefined,
  promptTokens: number,
): boolean {
  if (promptTokens <= CURSOR_LONG_CONTEXT_PROMPT_TOKENS) return true;
  return !CURSOR_MODELS_WITH_LONG_CONTEXT_RATE.has(rawModelId ? cursorModelName(rawModelId) : "");
}

/**
 * `rates` as OpenCode bills a Cursor model through cursor-opencode-provider: a cache write costs
 * Cursor's cache-write rate, nothing when Cursor publishes none. The provider settles each turn
 * at what Cursor billed partly with such free cache writes.
 */
export function cursorBilledRates(rawModelId: string | undefined, rates: CostBuckets): CostBuckets {
  const model = rawModelId ? cursorModelName(rawModelId) : "";
  const cacheWrite = CURSOR_MODELS_WITHOUT_CACHE_WRITE_RATE.has(model)
    ? 0
    : (rates.cache_write ?? 0);
  return { ...rates, cache_write: cacheWrite };
}

/** Ids may carry a provider prefix (`cursor/auto`); the last segment names the model. */
function cursorModelName(rawModelId: string): string {
  const trimmed = rawModelId.trim();
  return trimmed
    .slice(trimmed.lastIndexOf("/") + 1)
    .trim()
    .toLowerCase();
}

export function resolveCursorModel(rawModelId?: string): CursorResolvedModel {
  if (!rawModelId || typeof rawModelId !== "string") return { kind: "unknown" };

  const model = cursorModelName(rawModelId);

  // `default[]` is another id for Cursor's Auto model.
  const localModel = model === "default[]" ? "auto" : model;
  if (Object.hasOwn(CURSOR_LOCAL_PRICING, localModel)) {
    return { kind: "local", model: localModel as CursorLocalPricingModel, pool: "auto_composer" };
  }

  if (Object.hasOwn(CURSOR_OFFICIAL_MODEL_ALIASES, model)) {
    return { kind: "official", ...CURSOR_OFFICIAL_MODEL_ALIASES[model]!, pool: "api" };
  }
  return CURSOR_MODELS_WITH_OWN_PRICE.has(model) ? { kind: "unpriced" } : { kind: "unknown" };
}
