/**
 * Explicit native prices from local OpenCode configs. Mirrors OpenCode 2's
 * packages/core/src/config/plugin/provider.ts (replacement and cache defaults)
 * and packages/core/src/session/usage.ts (context tiers).
 * OpenCode returns zero USD for an empty cost list or no applicable rate; Quota
 * records zero USD and counts the tokens as unpriced.
 */
import { finiteNumber, isRecord } from "./json-guards.js";
import { readOpenCodeConfigs } from "./opencode-config-files.js";

/** USD per million tokens; reasoning uses output, omitted context means a base rate. */
export type ConfiguredUsageRate = Readonly<{
  input: number;
  output: number;
  reasoning: number;
  cache_read: number;
  cache_write: number;
  context?: number;
}>;

type ModelPrices = Readonly<Record<string, readonly ConfiguredUsageRate[]>>;

export type ConfiguredUsagePrices = Readonly<{
  providers: Readonly<Record<string, ModelPrices>>;
  /** Canonical JSON of sanitized prices only, independent of config paths and other fields. */
  fingerprint: string;
}>;

export const EMPTY_CONFIGURED_USAGE_PRICES: ConfiguredUsagePrices = Object.freeze({
  providers: Object.freeze(Object.create(null)),
  fingerprint: "{}",
});

function own(value: unknown, key: string): unknown {
  return isRecord(value) && Object.hasOwn(value, key) ? value[key] : undefined;
}

function isPrice(value: unknown): value is number {
  const number = finiteNumber(value);
  return number !== undefined && number >= 0;
}

function readRate(raw: unknown): ConfiguredUsageRate | undefined {
  if (!isRecord(raw)) return undefined;
  const input = own(raw, "input");
  const output = own(raw, "output");
  if (!isPrice(input) || !isPrice(output)) return undefined;

  const cache = own(raw, "cache");
  if (Object.hasOwn(raw, "cache") && !isRecord(cache)) return undefined;
  const read = isRecord(cache) && Object.hasOwn(cache, "read") ? cache.read : 0;
  const write = isRecord(cache) && Object.hasOwn(cache, "write") ? cache.write : 0;
  if (!isPrice(read) || !isPrice(write)) return undefined;

  let context: number | undefined;
  if (Object.hasOwn(raw, "tier")) {
    const tier = own(raw, "tier");
    const size = own(tier, "size");
    if (
      own(tier, "type") !== "context" ||
      typeof size !== "number" ||
      !Number.isSafeInteger(size) ||
      size < 0
    ) {
      return undefined;
    }
    context = size;
  }
  return Object.freeze({
    input,
    output,
    reasoning: output,
    cache_read: read,
    cache_write: write,
    ...(context === undefined ? {} : { context }),
  });
}

/** Invalid declarations preserve earlier prices; only an explicitly empty array clears them. */
function readRates(raw: unknown): readonly ConfiguredUsageRate[] | undefined {
  const entries = Array.isArray(raw) ? raw : [raw];
  const rates = entries.flatMap((entry) => {
    const rate = readRate(entry);
    return rate ? [rate] : [];
  });
  return entries.length > 0 && rates.length === 0 ? undefined : Object.freeze(rates);
}

/** One frozen snapshot for a report location, with later explicit cost lists replacing earlier ones. */
export async function loadConfiguredUsagePrices(directory: string): Promise<ConfiguredUsagePrices> {
  const providers: Record<string, Record<string, readonly ConfiguredUsageRate[]>> = Object.create(
    null,
  );
  for (const { config } of await readOpenCodeConfigs(directory)) {
    const configured = own(config, "providers");
    if (!isRecord(configured)) continue;
    for (const [providerID, provider] of Object.entries(configured)) {
      const models = own(provider, "models");
      if (!isRecord(models)) continue;
      for (const [modelID, model] of Object.entries(models)) {
        const rates = readRates(own(model, "cost"));
        if (rates) (providers[providerID] ??= Object.create(null))[modelID] = rates;
      }
    }
  }
  if (Object.keys(providers).length === 0) return EMPTY_CONFIGURED_USAGE_PRICES;

  const sorted: Record<string, ModelPrices> = Object.create(null);
  for (const providerID of Object.keys(providers).sort()) {
    const models = providers[providerID]!;
    const ordered: Record<string, readonly ConfiguredUsageRate[]> = Object.create(null);
    for (const modelID of Object.keys(models).sort()) ordered[modelID] = models[modelID]!;
    sorted[providerID] = Object.freeze(ordered);
  }
  return Object.freeze({ providers: Object.freeze(sorted), fingerprint: JSON.stringify(sorted) });
}
