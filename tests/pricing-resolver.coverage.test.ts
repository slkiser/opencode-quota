import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import { CURSOR_MODEL_COSTS } from "../.github/scripts/upstream-plugins/cursor-opencode-provider/dist/pricing-data.js";
import {
  CURSOR_OFFICIAL_MODEL_ALIASES,
  lookupCursorLocalCost,
  resolveCursorModel,
} from "../src/lib/cursor-pricing.js";
import { lookupCost, usePricingSettings } from "../src/lib/modelsdev-pricing.js";
import { loadConfiguredUsagePrices } from "../src/lib/opencode-usage-pricing.js";
import { priceMessage, resolvePricingKey } from "../src/lib/pricing-key.js";
import { useOpencodeFolders } from "./helpers/opencode-folders.js";
import { SHIPPED_PRICE_LIST } from "./helpers/shipped-price-list.js";

// Price not confirmed, so these stay unknown: models.dev rates differ from Cursor's for the
// Gemini 3.6 Flash and GLM 5.3 Flash ids, and the Muse models (meta) are not in the snapshot.
const CURSOR_UPSTREAM_INTENTIONALLY_UNKNOWN_MODELS = new Set<string>([
  "gemini-3.6-flash",
  "glm-5.3-flash",
  "muse-spark-1.3",
  "muse-wonder-1.0",
]);

/** "provider/model" of the price `resolvePricingKey` picks, or null when it finds none. */
function pricedKey(providerID: string, modelID: string): string | null {
  const resolved = resolvePricingKey({ providerID, modelID });
  return resolved.ok ? `${resolved.key.provider}/${resolved.key.model}` : null;
}

describe("resolvePricingKey snapshot coverage", () => {
  beforeEach(() => {
    usePricingSettings(() => ({ source: "bundled", autoRefreshDays: 7 }));
  });

  it("resolves every models.dev provider/model pair when source ids are official", () => {
    const shipped = Object.entries(SHIPPED_PRICE_LIST.providers);
    expect(shipped.length).toBeGreaterThan(0);
    const failures = shipped.flatMap(([providerID, models]) =>
      Object.keys(models)
        .map((modelID) => [`${providerID}/${modelID}`, pricedKey(providerID, modelID)])
        .filter(([expected, actual]) => actual !== expected)
        .map(([expected, actual]) => `${expected} -> ${actual}`),
    );
    expect(failures).toEqual([]);
  });

  it.each([
    ["connector-without-pricing-id", "anthropic/claude-haiku-4-5", "anthropic/claude-haiku-4-5"],
    ["github-copilot", "github-copilot/claude-haiku-4.5", "anthropic/claude-haiku-4-5"],
    ["github-copilot", "github-copilot/grok-code-fast-1", "xai/grok-code-fast-1"],
    ["CLIProxyAPI", "moonshotai/kimi-k2.5", "moonshotai/kimi-k2.5"],
    ["opencode", "opencode/kimi-k2.5-free", "moonshotai/kimi-k2.5"],
    ["openai", "openai/gpt-4o-mini-free", "openai/gpt-4o-mini"],
    ["connector-without-pricing-id", "openai/gpt-4o-mini-free", "openai/gpt-4o-mini"],
    ["kimi-for-coding", "k3", "moonshotai/kimi-k3"],
    ["kimi-for-coding", "k3-256k", "moonshotai/kimi-k3"],
    ["kimi-for-coding", "k3-free", null],
    ["kimi-for-coding", "k3-256k-free", null],
    ["kimi-for-coding", "k3-preview", null],
    ["cursor", "cursor/auto", "cursor/auto"],
    ["cursor", "auto", "cursor/auto"],
    ["cursor", "default[]", "cursor/auto"],
    ["cursor-acp", "cursor-acp/auto", "cursor/auto"],
    ["cursor", "cursor/composer-1", "cursor/composer-1"],
    ["cursor", "cursor/composer-1.5", "cursor/composer-1.5"],
    ["cursor", "cursor/composer-2", "cursor/composer-2"],
    ["cursor", "cursor/composer-2-fast", "cursor/composer-2-fast"],
    ["cursor", "cursor/composer", null],
    ["cursor", "cursor/composer-fast", null],
    ["cursor", "cursor/composer-2fast", null],
    ["cursor", "cursor/composer-2-fast-thinking", null],
    ["cursor", "cursor/composer-3", null],
    ["cursor", "gpt-5.4-high", "openai/gpt-5.4"],
    ["cursor", "cursor/sonnet-4.6-thinking", "anthropic/claude-sonnet-4-6"],
    ["cursor", "cursor/claude-4.5-sonnet", "anthropic/claude-sonnet-4-5"],
    ["cursor", "cursor/claude-4.6-opus", "anthropic/claude-opus-4-6"],
    ["cursor", "cursor/claude-4.6-sonnet", "anthropic/claude-sonnet-4-6"],
  ])("prices %s %s as %s", (providerID, modelID, expected) => {
    expect(pricedKey(providerID, modelID)).toBe(expected);
  });

  // Upstream no longer lists these, so the upstream check below does not cover their rates.
  it.each([
    ["auto", { input: 1.25, output: 6, cache_read: 0.25 }],
    ["composer-1", { input: 1.25, output: 10, cache_read: 0.125 }],
    ["composer-1.5", { input: 3.5, output: 17.5, cache_read: 0.35 }],
    ["composer-2", { input: 0.5, output: 2.5, cache_read: 0.2 }],
    ["composer-2-fast", { input: 1.5, output: 7.5, cache_read: 0.35 }],
  ])("prices the older Cursor model %s at its published rates", (model, rates) => {
    expect(lookupCursorLocalCost(model)).toEqual(rates);
  });

  it.each([
    ["claude-fable-5-2", { input: 8, output: 40, cache_read: 0.2, cache_write: 10 }],
    ["deepseek-v41-flash-1017", { input: 0.3, output: 1.2, cache_read: 0.006 }],
  ])("looks up the new Cursor model %s at its published rates", (model, rates) => {
    expect(lookupCursorLocalCost(model)).toEqual(rates);
  });

  it("prices every synced upstream Cursor model's messages at Cursor's published rates", () => {
    type UpstreamRates = {
      input: number;
      output: number;
      cache_read: number;
      cache_write?: number;
    };
    const upstream: Record<string, UpstreamRates & { context_over_200k?: UpstreamRates }> =
      CURSOR_MODEL_COSTS;
    const stale = [...CURSOR_UPSTREAM_INTENTIONALLY_UNKNOWN_MODELS].filter((id) => !upstream[id]);
    expect(stale, "Remove ids upstream no longer prices from the unknown list").toEqual([]);

    // Each token kind at its own rate. At most 200k tokens of prompt is the base tier; over
    // 200k, Cursor bills a model with a long-context tier at rates no price here holds.
    const base = {
      input: 70_000,
      output: 30_000,
      reasoning: 0,
      cache_read: 90_000,
      cache_write: 40_000,
    };
    const long = { ...base, input: base.input + 1 };
    const usd = (rates: UpstreamRates, tokens: typeof base) =>
      (tokens.input * rates.input +
        tokens.output * rates.output +
        tokens.cache_read * rates.cache_read +
        tokens.cache_write * (rates.cache_write ?? 0)) /
      1_000_000;
    const outcome = (price: ReturnType<typeof priceMessage>) =>
      price.kind === "priced"
        ? `${price.key.provider}/${price.key.model} $${price.usd.toFixed(9)}`
        : price.kind;

    const failures: string[] = [];
    for (const [modelID, rates] of Object.entries(upstream)) {
      const source = { providerID: "cursor", modelID: `cursor/${modelID}` };
      const alias = CURSOR_OFFICIAL_MODEL_ALIASES[modelID];
      const key = lookupCursorLocalCost(modelID)
        ? `cursor/${modelID}`
        : `${alias?.providerHint}/${alias?.modelHint}`;
      const expected = CURSOR_UPSTREAM_INTENTIONALLY_UNKNOWN_MODELS.has(modelID)
        ? ["unknown", "unknown"]
        : [
            `${key} $${usd(rates, base).toFixed(9)}`,
            rates.context_over_200k ? "unpriced" : `${key} $${usd(rates, long).toFixed(9)}`,
          ];
      const actual = [base, long].map((tokens) => outcome(priceMessage(source, tokens)));
      if (actual.join() !== expected.join()) {
        failures.push(`${modelID} -> ${actual.join(", ")} instead of ${expected.join(", ")}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it.each(["claude-sonnet-4", "cursor-acp/claude-sonnet-4"])(
    "leaves a request over 200k tokens of %s, a model with a long-context tier, unpriced",
    (modelID) => {
      const tokens = { input: 200_001, output: 1, reasoning: 0, cache_read: 0, cache_write: 0 };
      expect(priceMessage({ providerID: "cursor", modelID }, tokens)).toEqual({
        kind: "unpriced",
        key: { provider: "anthropic", model: "claude-sonnet-4-0" },
      });
    },
  );

  it("prices -1m ids at the base rate only where Cursor documents no long-context surcharge", () => {
    const sameRate = [
      "claude-fable-5",
      "claude-fable-5-1",
      "claude-haiku-5-5",
      "claude-opus-4-6",
      "claude-opus-4-7",
      "claude-opus-4-8",
      "claude-opus-5",
      "claude-opus-5-5",
      "claude-sonnet-4-5",
      "claude-sonnet-4-6",
      "claude-sonnet-5",
      "claude-sonnet-5-5",
      "gpt-5.4",
      "gpt-5.5",
      "gpt-5.6-luna",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "kimi-k3",
    ];
    for (const base of sameRate) {
      expect(resolveCursorModel(`cursor/${base}-1m`), base).toEqual(
        resolveCursorModel(`cursor/${base}`),
      );
    }
    // Unpublished (Auto) or tiered long-context prices stay unknown instead of a guess.
    const unconfirmed = [
      "default",
      "claude-sonnet-4-1m",
      "grok-4.7-1m",
      "grok-4.7-1m-fast",
      "grok-4.7-500k",
      "grok-4.7-500k-fast",
    ];
    for (const modelID of unconfirmed) {
      expect(resolveCursorModel(`cursor/${modelID}`), modelID).toEqual({ kind: "unknown" });
    }
  });

  it("keeps every Cursor API alias aligned with a priced snapshot key", () => {
    const failures = Object.entries(CURSOR_OFFICIAL_MODEL_ALIASES)
      .map(([alias, { providerHint, modelHint }]) => {
        const resolved = resolvePricingKey({ providerID: "cursor", modelID: `cursor/${alias}` });
        const target = `${providerHint}/${modelHint}`;
        if (!resolved.ok || resolved.method !== "cursor_api_alias") return `${alias} -> unresolved`;
        const key = `${resolved.key.provider}/${resolved.key.model}`;
        if (key !== target) return `${alias} -> ${key} (expected ${target})`;
        return lookupCost(providerHint, modelHint) ? null : `${alias} -> no price for ${target}`;
      })
      .filter((failure) => failure !== null);
    expect(failures).toEqual([]);
  });
});

describe("priceMessage", () => {
  beforeEach(() => {
    usePricingSettings(() => ({ source: "bundled", autoRefreshDays: 7 }));
  });

  const MILLION = {
    input: 1_000_000,
    output: 1_000_000,
    reasoning: 0,
    cache_read: 0,
    cache_write: 0,
  };

  it.each([
    ["constructor", "constructor"],
    ["openai", "constructor"],
    ["__proto__", "toString"],
    ["cursor", "cursor/constructor"],
    ["cursor", "hasOwnProperty"],
  ])("knows no price for the object key %s/%s", (providerID, modelID) => {
    expect(priceMessage({ providerID, modelID }, MILLION, { modelMap: {} })).toEqual({
      kind: "unknown",
    });
  });

  it("prices Cursor's Auto from Cursor's own table, whatever the provider id", () => {
    const price = priceMessage({ providerID: "cursor", modelID: "auto" }, MILLION);
    expect(price).toMatchObject({ kind: "priced", key: { provider: "cursor", model: "auto" } });
    expect(price.kind === "priced" && price.usd).toBeCloseTo(7.25, 6);
  });

  it("prices each token kind, with cache savings against the input price", () => {
    const price = priceMessage(
      { providerID: "openai", modelID: "gpt-5" },
      { input: 1_000_000, output: 0, reasoning: 1_000_000, cache_read: 1_000_000, cache_write: 0 },
    );
    if (price.kind !== "priced") throw new Error(price.kind);
    expect(price.byKind).toEqual({
      input: 1.25,
      output: 0,
      reasoning: 10,
      cache_read: 0.125,
      cache_write: 0,
    });
    expect(price.usd).toBeCloseTo(11.375, 9);
    expect(price.cacheSavingsUsd).toBeCloseTo(1.125, 9);
  });

  it("uses a model map only for a model automatic matching cannot price", () => {
    const modelMap = { "private-model": "openai/gpt-5", "gpt-5": "anthropic/claude-opus-4-5" };
    const mapped = priceMessage({ providerID: "gateway", modelID: "private-model" }, MILLION, {
      modelMap,
    });
    const automatic = priceMessage({ providerID: "openai", modelID: "gpt-5" }, MILLION, {
      modelMap,
    });
    expect(mapped).toMatchObject({ kind: "priced", key: { provider: "openai", model: "gpt-5" } });
    expect(automatic).toMatchObject({
      kind: "priced",
      key: { provider: "openai", model: "gpt-5" },
    });
    expect(priceMessage({ providerID: "gateway", modelID: "private-model" }, MILLION)).toEqual({
      kind: "unknown",
    });
  });
});

describe("configured Usage prices", () => {
  const folders = useOpencodeFolders();
  const directory = join(folders.root, "repo", "app");
  const configPath = join(directory, "opencode.jsonc");
  const source = { providerID: "team-gateway", modelID: "demo/model" };
  const cost = { input: 2, output: 6, cache: { read: 0.5, write: 0 } };
  const tokens = {
    input: 1_000_000,
    output: 100_000,
    reasoning: 50_000,
    cache_read: 2_000_000,
    cache_write: 100_000,
  };
  const config = (value: unknown) => ({
    providers: {
      "team-gateway": { models: { "demo/model": { modelID: "wire-model", cost: value } } },
    },
  });
  function writeConfig(path: string, value: unknown): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(value));
  }

  it("overrides a cached catalog hit without changing another provider or the catalog baseline", async () => {
    usePricingSettings(() => ({ source: "bundled", autoRefreshDays: 7 }));
    const official = { providerID: "openai", modelID: "gpt-5" };
    const other = { providerID: "github-copilot", modelID: "gpt-5" };
    const catalog = priceMessage(official, tokens);
    const otherCatalog = priceMessage(other, tokens);
    expect(catalog.kind).toBe("priced");
    writeConfig(configPath, { providers: { openai: { models: { "gpt-5": { cost } } } } });
    const configuredPrices = await loadConfiguredUsagePrices(directory);
    expect(priceMessage(official, tokens, { configuredPrices })).toMatchObject({
      kind: "priced",
      usd: expect.closeTo(3.9, 9),
    });
    expect(priceMessage(other, tokens, { configuredPrices })).toEqual(otherCatalog);
    expect(priceMessage(official, tokens)).toEqual(catalog);
  });

  it.each([
    { providerID: "team-gateway", modelID: "demo/model", configured: true },
    { providerID: "Team-Gateway", modelID: "demo/model", configured: false },
    { providerID: "team-gateway", modelID: "Demo/model", configured: false },
    { providerID: "team-gateway", modelID: "wire-model", configured: false },
  ])(
    "joins only the exact local tuple $providerID/$modelID",
    async ({ providerID, modelID, configured }) => {
      writeConfig(configPath, config(cost));
      const configuredPrices = await loadConfiguredUsagePrices(directory);
      const original = { providerID, modelID };
      expect(priceMessage(original, tokens, { configuredPrices })).toEqual(
        configured
          ? expect.objectContaining({
              kind: "priced",
              key: { provider: providerID, model: modelID },
            })
          : priceMessage(original, tokens),
      );
    },
  );

  it.each([
    { cost: { input: 0, output: 0 }, usd: 0, savings: 0 },
    { cost: { input: 2, output: 6 }, usd: 2.9, savings: 4 },
  ])("keeps zero and missing cache prices explicit ($usd USD)", async (item) => {
    writeConfig(configPath, config(item.cost));
    const configuredPrices = await loadConfiguredUsagePrices(directory);
    expect(priceMessage(source, tokens, { configuredPrices })).toMatchObject({
      kind: "priced",
      usd: expect.closeTo(item.usd, 9),
      cacheSavingsUsd: item.savings,
      byKind: {
        reasoning: expect.closeTo((tokens.reasoning * item.cost.output) / 1_000_000, 12),
        cache_read: 0,
        cache_write: 0,
      },
    });
  });

  it.each([
    { label: "[]", cost: [] },
    {
      label: "no matching tier or base",
      cost: [{ ...cost, tier: { type: "context", size: 4_000_000 } }],
    },
  ])("keeps $label unpriced despite catalog and model-map prices", async (item) => {
    usePricingSettings(() => ({ source: "bundled", autoRefreshDays: 7 }));
    const official = { providerID: "openai", modelID: "gpt-5" };
    expect(priceMessage(official, tokens).kind).toBe("priced");
    writeConfig(configPath, {
      providers: { openai: { models: { "gpt-5": { cost: item.cost } } } },
    });
    const configuredPrices = await loadConfiguredUsagePrices(directory);
    expect(
      priceMessage(official, tokens, {
        configuredPrices,
        modelMap: { "gpt-5": "anthropic/claude-opus-4-5" },
      }),
    ).toEqual({ kind: "unpriced", key: { provider: "openai", model: "gpt-5" } });
  });

  it.each([
    { prompt: 99, inputRate: 2, outputRate: 3 },
    { prompt: 100, inputRate: 2, outputRate: 3 },
    { prompt: 101, inputRate: 10, outputRate: 0 },
    { prompt: 201, inputRate: 20, outputRate: 0 },
  ])(
    "uses the first largest strictly exceeded tier at $prompt tokens including caches",
    async ({ prompt, inputRate, outputRate }) => {
      writeConfig(
        configPath,
        config([
          { input: 20, output: 0, tier: { type: "context", size: 200 } },
          { input: 2, output: 3 },
          { input: 10, output: 0, tier: { type: "context", size: 100 } },
          { input: 999, output: 0, tier: { type: "context", size: 200 } },
          { input: 777, output: 999 },
        ]),
      );
      const configuredPrices = await loadConfiguredUsagePrices(directory);
      const tierTokens = { ...tokens, input: prompt - 50, cache_read: 30, cache_write: 20 };
      expect(priceMessage(source, tierTokens, { configuredPrices })).toMatchObject({
        kind: "priced",
        usd: expect.closeTo((tierTokens.input * inputRate) / 1_000_000 + 0.15 * outputRate, 12),
      });
    },
  );
});
