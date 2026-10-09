import { readFileSync } from "node:fs";

import { beforeEach, describe, expect, it } from "vitest";
import {
  CURSOR_OFFICIAL_MODEL_ALIASES,
  lookupCursorLocalCost,
  resolveCursorModel,
} from "../src/lib/cursor-pricing.js";
import {
  listModelsForProvider,
  listProviders,
  lookupCost,
  setPricingSnapshotSelection,
} from "../src/lib/modelsdev-pricing.js";
import { resolvePricingKey } from "../src/lib/quota-stats.js";

const CURSOR_UPSTREAM_PRICING_PATH = new URL(
  "../references/upstream-plugins/cursor-opencode-provider/dist/pricing-data.js",
  import.meta.url,
);

// Price not confirmed, so these stay unknown: models.dev rates differ from Cursor's for the
// Gemini Flash and GLM 5.3 Flash ids, and muse-spark (meta) is not a pricing snapshot provider.
const CURSOR_UPSTREAM_INTENTIONALLY_UNKNOWN_MODELS = new Set<string>([
  "gemini-3.6-flash",
  "gemini-3.7-flash",
  "gemini-3.8-flash",
  "glm-5.3-flash",
  "muse-spark-1.3",
]);

function getCursorUpstreamPricedModelIds(): string[] {
  const source = readFileSync(CURSOR_UPSTREAM_PRICING_PATH, "utf8");
  const marker = "export const CURSOR_MODEL_COSTS = ";
  const start = source.indexOf(marker);
  if (start === -1) {
    throw new Error("Unable to locate Cursor upstream CURSOR_MODEL_COSTS in synced reference");
  }

  const bodyStart = start + marker.length;
  let depth = 0;
  let bodyEnd = -1;
  for (let index = bodyStart; index < source.length; index += 1) {
    const char = source[index];
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        bodyEnd = index;
        break;
      }
    }
  }

  if (source[bodyStart] !== "{" || bodyEnd === -1) {
    throw new Error("Unable to parse Cursor upstream CURSOR_MODEL_COSTS in synced reference");
  }

  const costs = JSON.parse(source.slice(bodyStart, bodyEnd + 1)) as Record<string, unknown>;
  return Object.keys(costs).sort((a, b) => a.localeCompare(b));
}

describe("resolvePricingKey snapshot coverage", () => {
  beforeEach(() => {
    setPricingSnapshotSelection("bundled");
  });

  it("resolves every models.dev provider/model pair when source ids are official", () => {
    const failures: string[] = [];
    const providers = listProviders();
    expect(providers.length).toBeGreaterThan(0);

    outer: for (const providerID of providers) {
      const modelIDs = listModelsForProvider(providerID);
      for (const modelID of modelIDs) {
        const resolved = resolvePricingKey({ providerID, modelID });
        if (!resolved.ok) {
          failures.push(`${providerID}/${modelID} -> unresolved`);
        } else if (resolved.key.provider !== providerID || resolved.key.model !== modelID) {
          failures.push(
            `${providerID}/${modelID} -> ${resolved.key.provider}/${resolved.key.model} (${resolved.method})`,
          );
        }
        if (failures.length >= 10) break outer;
      }
    }

    expect(failures).toEqual([]);
  });

  it("resolves provider/model prefixes even when source provider id is unknown", () => {
    const providers = listProviders();
    const providerID = providers[0];
    expect(providerID).toBeTruthy();

    const modelID = listModelsForProvider(providerID!)[0];
    expect(modelID).toBeTruthy();

    const resolved = resolvePricingKey({
      providerID: "connector-without-pricing-id",
      modelID: `${providerID}/${modelID}`,
    });

    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.key.provider).toBe(providerID);
    expect(resolved.key.model).toBe(modelID);
  });

  it("maps copilot and proxy model variants to priced snapshot keys", () => {
    const copilotHaiku = resolvePricingKey({
      providerID: "github-copilot",
      modelID: "github-copilot/claude-haiku-4.5",
    });
    expect(copilotHaiku.ok).toBe(true);
    if (!copilotHaiku.ok) return;
    expect(copilotHaiku.key).toEqual({ provider: "anthropic", model: "claude-haiku-4-5" });

    const copilotGrok = resolvePricingKey({
      providerID: "github-copilot",
      modelID: "github-copilot/grok-code-fast-1",
    });
    expect(copilotGrok.ok).toBe(true);
    if (!copilotGrok.ok) return;
    expect(copilotGrok.key).toEqual({ provider: "xai", model: "grok-code-fast-1" });

    const kimiBase = resolvePricingKey({
      providerID: "CLIProxyAPI",
      modelID: "moonshotai/kimi-k2.5",
    });
    expect(kimiBase.ok).toBe(true);
    if (!kimiBase.ok) return;
    expect(kimiBase.key).toEqual({ provider: "moonshotai", model: "kimi-k2.5" });

    const kimiFree = resolvePricingKey({
      providerID: "opencode",
      modelID: "opencode/kimi-k2.5-free",
    });
    expect(kimiFree.ok).toBe(true);
    if (!kimiFree.ok) return;
    expect(kimiFree.key).toEqual({ provider: "moonshotai", model: "kimi-k2.5" });

    const openaiFreeKnownProvider = resolvePricingKey({
      providerID: "openai",
      modelID: "openai/gpt-4o-mini-free",
    });
    expect(openaiFreeKnownProvider.ok).toBe(true);
    if (!openaiFreeKnownProvider.ok) return;
    expect(openaiFreeKnownProvider.key).toEqual({ provider: "openai", model: "gpt-4o-mini" });

    const openaiFreeModelPrefix = resolvePricingKey({
      providerID: "connector-without-pricing-id",
      modelID: "openai/gpt-4o-mini-free",
    });
    expect(openaiFreeModelPrefix.ok).toBe(true);
    if (!openaiFreeModelPrefix.ok) return;
    expect(openaiFreeModelPrefix.key).toEqual({ provider: "openai", model: "gpt-4o-mini" });

    expect(lookupCost("anthropic", "claude-haiku-4-5")).not.toBeNull();
    expect(lookupCost("xai", "grok-code-fast-1")).not.toBeNull();
    expect(lookupCost("moonshotai", "kimi-k2.5")).not.toBeNull();
    expect(lookupCost("openai", "gpt-4o-mini")).not.toBeNull();
  });

  it("maps documented Kimi Code K3 models to authoritative pricing", () => {
    for (const modelID of ["k3", "k3-256k"]) {
      expect(
        resolvePricingKey({
          providerID: "kimi-for-coding",
          modelID,
        }),
      ).toEqual({
        ok: true,
        key: { provider: "moonshotai", model: "kimi-k3" },
        method: "source_provider",
      });
    }

    expect(lookupCost("moonshotai", "kimi-k3")).toEqual({
      input: 3,
      output: 15,
      cache_read: 0.3,
    });

    for (const modelID of ["k3-free", "k3-256k-free", "k3-preview"]) {
      expect(
        resolvePricingKey({
          providerID: "kimi-for-coding",
          modelID,
        }).ok,
      ).toBe(false);
    }
  });

  it("maps cursor local and api-pool models into deterministic pricing keys", () => {
    const auto = resolvePricingKey({
      providerID: "cursor",
      modelID: "cursor/auto",
    });
    expect(auto.ok).toBe(true);
    if (!auto.ok) return;
    expect(auto.key).toEqual({ provider: "cursor", model: "auto" });

    const autoBare = resolvePricingKey({
      providerID: "cursor",
      modelID: "auto",
    });
    expect(autoBare.ok).toBe(true);
    if (!autoBare.ok) return;
    expect(autoBare.key).toEqual({ provider: "cursor", model: "auto" });

    const autoDefault = resolvePricingKey({
      providerID: "cursor",
      modelID: "default[]",
    });
    expect(autoDefault.ok).toBe(true);
    if (!autoDefault.ok) return;
    expect(autoDefault.key).toEqual({ provider: "cursor", model: "auto" });

    const legacyAuto = resolvePricingKey({
      providerID: "cursor-acp",
      modelID: "cursor-acp/auto",
    });
    expect(legacyAuto.ok).toBe(true);
    if (!legacyAuto.ok) return;
    expect(legacyAuto.key).toEqual({ provider: "cursor", model: "auto" });

    const composer1 = resolvePricingKey({
      providerID: "cursor",
      modelID: "cursor/composer-1",
    });
    expect(composer1.ok).toBe(true);
    if (!composer1.ok) return;
    expect(composer1.key).toEqual({ provider: "cursor", model: "composer-1" });

    const composer15 = resolvePricingKey({
      providerID: "cursor",
      modelID: "cursor/composer-1.5",
    });
    expect(composer15.ok).toBe(true);
    if (!composer15.ok) return;
    expect(composer15.key).toEqual({ provider: "cursor", model: "composer-1.5" });

    const composer2 = resolvePricingKey({
      providerID: "cursor",
      modelID: "cursor/composer-2",
    });
    expect(composer2.ok).toBe(true);
    if (!composer2.ok) return;
    expect(composer2.key).toEqual({ provider: "cursor", model: "composer-2" });

    const composer2Fast = resolvePricingKey({
      providerID: "cursor",
      modelID: "cursor/composer-2-fast",
    });
    expect(composer2Fast.ok).toBe(true);
    if (!composer2Fast.ok) return;
    expect(composer2Fast.key).toEqual({ provider: "cursor", model: "composer-2-fast" });

    for (const unsupportedModelID of [
      "cursor/composer",
      "cursor/composer-fast",
      "cursor/composer-2fast",
      "cursor/composer-2-fast-thinking",
      "cursor/composer-3",
    ]) {
      expect(
        resolvePricingKey({
          providerID: "cursor",
          modelID: unsupportedModelID,
        }).ok,
      ).toBe(false);
    }

    const gpt = resolvePricingKey({
      providerID: "cursor",
      modelID: "gpt-5.4-high",
    });
    expect(gpt.ok).toBe(true);
    if (!gpt.ok) return;
    expect(gpt.key).toEqual({ provider: "openai", model: "gpt-5.4" });

    const anthropic = resolvePricingKey({
      providerID: "cursor",
      modelID: "cursor/sonnet-4.6-thinking",
    });
    expect(anthropic.ok).toBe(true);
    if (!anthropic.ok) return;
    expect(anthropic.key).toEqual({ provider: "anthropic", model: "claude-sonnet-4-6" });

    const discoveredAnthropicIds = [
      ["cursor/claude-4.5-sonnet", { provider: "anthropic", model: "claude-sonnet-4-5" }],
      ["cursor/claude-4.6-opus", { provider: "anthropic", model: "claude-opus-4-6" }],
      ["cursor/claude-4.6-sonnet", { provider: "anthropic", model: "claude-sonnet-4-6" }],
    ] as const;

    for (const [modelID, key] of discoveredAnthropicIds) {
      const resolved = resolvePricingKey({
        providerID: "cursor",
        modelID,
      });
      expect(resolved.ok).toBe(true);
      if (!resolved.ok) continue;
      expect(resolved.key).toEqual(key);
    }
  });

  it("keeps cursor local pricing buckets distinct", () => {
    expect(lookupCursorLocalCost("auto")).toEqual({
      input: 1.25,
      cache_read: 0.25,
      output: 6,
    });
    expect(lookupCursorLocalCost("composer-1")).toEqual({
      input: 1.25,
      cache_read: 0.125,
      output: 10,
    });
    expect(lookupCursorLocalCost("composer-1.5")).toEqual({
      input: 3.5,
      cache_read: 0.35,
      output: 17.5,
    });
    expect(lookupCursorLocalCost("composer-2")).toEqual({
      input: 0.5,
      cache_read: 0.2,
      output: 2.5,
    });
    expect(lookupCursorLocalCost("composer-2-fast")).toEqual({
      input: 1.5,
      cache_read: 0.35,
      output: 7.5,
    });
    expect(lookupCursorLocalCost("composer-2.5")).toEqual({
      input: 0.5,
      cache_read: 0.2,
      output: 2.5,
    });
    expect(lookupCursorLocalCost("composer-2.5-fast")).toEqual({
      input: 3,
      cache_read: 0.5,
      output: 15,
    });
    expect(lookupCursorLocalCost("grok-4.5")).toEqual({ input: 2, cache_read: 0.5, output: 6 });
    expect(lookupCursorLocalCost("grok-4.5-fast")).toEqual({ input: 4, cache_read: 1, output: 18 });
    expect(lookupCursorLocalCost("grok-4.6")).toEqual({ input: 2, cache_read: 0.5, output: 6 });
    expect(lookupCursorLocalCost("grok-4.6-fast")).toEqual({ input: 4, cache_read: 1, output: 12 });
    expect(lookupCursorLocalCost("grok-4.7")).toEqual({ input: 2, cache_read: 0.5, output: 6 });
    expect(lookupCursorLocalCost("grok-4.7-fast")).toEqual({ input: 4, cache_read: 1, output: 12 });
  });

  it("prices cursor-opencode-provider model ids at Cursor's published rates", () => {
    const cursorModelsPool = [
      "composer-2.5",
      "composer-2.5-fast",
      "grok-4.5",
      "grok-4.5-fast",
      "grok-4.6",
      "grok-4.6-fast",
      "grok-4.7",
      "grok-4.7-fast",
    ];
    for (const modelID of cursorModelsPool) {
      expect(resolveCursorModel(`cursor/${modelID}`), modelID).toEqual({
        kind: "local",
        model: modelID,
        pool: "auto_composer",
      });
    }

    const otherModelsPool = [
      ["claude-fable-5", "anthropic", "claude-fable-5", { input: 10, output: 50, cache_read: 1 }],
      [
        "claude-fable-5-1",
        "anthropic",
        "claude-fable-5-1",
        { input: 10, output: 50, cache_read: 0.25 },
      ],
      [
        "claude-haiku-4-5",
        "anthropic",
        "claude-haiku-4-5",
        { input: 1, output: 5, cache_read: 0.1 },
      ],
      [
        "claude-haiku-5-5",
        "anthropic",
        "claude-haiku-5-5",
        { input: 0.1, output: 0.5, cache_read: 0.01, cache_write: 0.125 },
      ],
      [
        "claude-opus-4-5",
        "anthropic",
        "claude-opus-4-5",
        { input: 5, output: 25, cache_read: 0.5 },
      ],
      [
        "claude-opus-4-6",
        "anthropic",
        "claude-opus-4-6",
        { input: 5, output: 25, cache_read: 0.5 },
      ],
      [
        "claude-opus-4-7",
        "anthropic",
        "claude-opus-4-7",
        { input: 5, output: 25, cache_read: 0.5 },
      ],
      [
        "claude-opus-4-8",
        "anthropic",
        "claude-opus-4-8",
        { input: 5, output: 25, cache_read: 0.5 },
      ],
      ["claude-opus-5", "anthropic", "claude-opus-5", { input: 5, output: 25, cache_read: 0.5 }],
      [
        "claude-opus-5-5",
        "anthropic",
        "claude-opus-5-5",
        { input: 4, output: 20, cache_read: 0.2 },
      ],
      [
        "claude-sonnet-4",
        "anthropic",
        "claude-sonnet-4-0",
        { input: 3, output: 15, cache_read: 0.3 },
      ],
      [
        "claude-sonnet-4-5",
        "anthropic",
        "claude-sonnet-4-5",
        { input: 3, output: 15, cache_read: 0.3 },
      ],
      [
        "claude-sonnet-4-6",
        "anthropic",
        "claude-sonnet-4-6",
        { input: 3, output: 15, cache_read: 0.3 },
      ],
      [
        "claude-sonnet-5",
        "anthropic",
        "claude-sonnet-5",
        { input: 2, output: 10, cache_read: 0.2 },
      ],
      [
        "claude-sonnet-5-5",
        "anthropic",
        "claude-sonnet-5-5",
        { input: 2, output: 10, cache_read: 0.1 },
      ],
      [
        "gemini-2.5-flash",
        "google",
        "gemini-2.5-flash",
        { input: 0.3, output: 2.5, cache_read: 0.03 },
      ],
      [
        "gemini-3-flash",
        "google",
        "gemini-3-flash-preview",
        { input: 0.5, output: 3, cache_read: 0.05 },
      ],
      [
        "gemini-3.1-pro",
        "google",
        "gemini-3.1-pro-preview",
        { input: 2, output: 12, cache_read: 0.2 },
      ],
      [
        "gemini-3.5-flash",
        "google",
        "gemini-3.5-flash",
        { input: 1.5, output: 9, cache_read: 0.15 },
      ],
      ["glm-5.2", "zai", "glm-5.2", { input: 1.4, output: 4.4, cache_read: 0.26 }],
      ["glm-5.3", "zai", "glm-5.3", { input: 1.4, output: 4.4, cache_read: 0.26 }],
      ["gpt-5-mini", "openai", "gpt-5-mini", { input: 0.25, output: 2, cache_read: 0.025 }],
      ["gpt-5.1", "openai", "gpt-5.1", { input: 1.25, output: 10, cache_read: 0.125 }],
      ["gpt-5.2", "openai", "gpt-5.2", { input: 1.75, output: 14, cache_read: 0.175 }],
      ["gpt-5.3-codex", "openai", "gpt-5.3-codex", { input: 1.75, output: 14, cache_read: 0.175 }],
      ["gpt-5.4", "openai", "gpt-5.4", { input: 2.5, output: 15, cache_read: 0.25 }],
      ["gpt-5.4-mini", "openai", "gpt-5.4-mini", { input: 0.75, output: 4.5, cache_read: 0.075 }],
      ["gpt-5.4-nano", "openai", "gpt-5.4-nano", { input: 0.2, output: 1.25, cache_read: 0.02 }],
      ["gpt-5.5", "openai", "gpt-5.5", { input: 5, output: 30, cache_read: 0.5 }],
      ["gpt-5.6-luna", "openai", "gpt-5.6-luna", { input: 0.2, output: 1.2, cache_read: 0.02 }],
      ["gpt-5.6-sol", "openai", "gpt-5.6-sol", { input: 4, output: 20, cache_read: 0.4 }],
      ["gpt-5.6-terra", "openai", "gpt-5.6-terra", { input: 2, output: 12, cache_read: 0.2 }],
      [
        "kimi-k2.7-code",
        "moonshotai",
        "kimi-k2.7-code",
        { input: 0.95, output: 4, cache_read: 0.19 },
      ],
      ["kimi-k3", "moonshotai", "kimi-k3", { input: 3, output: 15, cache_read: 0.3 }],
    ] as const;
    for (const [modelID, providerHint, modelHint, rates] of otherModelsPool) {
      expect(resolveCursorModel(`cursor/${modelID}`), modelID).toEqual({
        kind: "official",
        providerHint,
        modelHint,
        pool: "api",
      });
      expect(lookupCost(providerHint, modelHint), modelID).toMatchObject(rates);
    }
  });

  it("prices -1m ids at the base rate only where Cursor documents no long-context surcharge", () => {
    const sameRateLongContext = [
      ["claude-opus-4-6-1m", "claude-opus-4-6"],
      ["claude-opus-4-7-1m", "claude-opus-4-7"],
      ["claude-opus-4-8-1m", "claude-opus-4-8"],
      ["claude-opus-5-1m", "claude-opus-5"],
      ["claude-opus-5-5-1m", "claude-opus-5-5"],
      ["claude-sonnet-4-5-1m", "claude-sonnet-4-5"],
      ["claude-sonnet-4-6-1m", "claude-sonnet-4-6"],
      ["claude-sonnet-5-1m", "claude-sonnet-5"],
      ["claude-sonnet-5-5-1m", "claude-sonnet-5-5"],
      ["kimi-k3-1m", "kimi-k3"],
    ] as const;
    for (const [modelID, baseModelID] of sameRateLongContext) {
      expect(resolveCursorModel(`cursor/${modelID}`), modelID).toEqual(
        resolveCursorModel(`cursor/${baseModelID}`),
      );
    }

    // Unpublished (Auto), tiered long-context surcharges, or models.dev rates that differ
    // from Cursor's published rates stay unknown instead of guessing a price.
    const unconfirmed = [
      "default",
      "claude-haiku-5-5-1m",
      "claude-fable-5-1m",
      "claude-fable-5-1-1m",
      "claude-sonnet-4-1m",
      "gemini-3.6-flash",
      "gemini-3.7-flash",
      "gemini-3.8-flash",
      "glm-5.3-flash",
      "gpt-5.4-1m",
      "gpt-5.5-1m",
      "gpt-5.6-sol-1m",
      "grok-4.7-1m",
      "grok-4.7-1m-fast",
      "muse-spark-1.3",
    ];
    for (const modelID of unconfirmed) {
      expect(resolveCursorModel(`cursor/${modelID}`), modelID).toEqual({ kind: "unknown" });
    }
  });

  it("keeps every Cursor API alias aligned with a priced snapshot key", () => {
    const failures: string[] = [];

    for (const alias of Object.keys(CURSOR_OFFICIAL_MODEL_ALIASES).sort()) {
      const target = CURSOR_OFFICIAL_MODEL_ALIASES[alias];
      if (!target || target.providerHint === "cursor") continue;

      const resolved = resolvePricingKey({
        providerID: "cursor",
        modelID: `cursor/${alias}`,
      });

      if (!resolved.ok) {
        failures.push(`${alias} -> unresolved`);
        continue;
      }

      if (resolved.method !== "cursor_api_alias") {
        failures.push(`${alias} -> unexpected method ${resolved.method}`);
        continue;
      }

      if (
        resolved.key.provider !== target.providerHint ||
        resolved.key.model !== target.modelHint
      ) {
        failures.push(
          `${alias} -> ${resolved.key.provider}/${resolved.key.model} (expected ${target.providerHint}/${target.modelHint})`,
        );
        continue;
      }

      if (!lookupCost(resolved.key.provider, resolved.key.model)) {
        failures.push(
          `${alias} -> missing priced snapshot key ${resolved.key.provider}/${resolved.key.model}`,
        );
      }
    }

    expect(failures).toEqual([]);
  });

  it("accounts for every synced upstream Cursor priced model id", () => {
    const upstreamModelIds = getCursorUpstreamPricedModelIds();
    const intentionallyUnknown = [...CURSOR_UPSTREAM_INTENTIONALLY_UNKNOWN_MODELS].sort((a, b) =>
      a.localeCompare(b),
    );

    expect(
      intentionallyUnknown.filter((modelID) => !upstreamModelIds.includes(modelID)),
      "Remove stale entries from CURSOR_UPSTREAM_INTENTIONALLY_UNKNOWN_MODELS when upstream priced ids change.",
    ).toEqual([]);

    const failures: string[] = [];

    for (const modelID of upstreamModelIds) {
      const resolvedModel = resolveCursorModel(`cursor/${modelID}`);
      const resolvedPricing = resolvePricingKey({
        providerID: "cursor",
        modelID: `cursor/${modelID}`,
      });

      if (resolvedModel.kind === "unknown") {
        if (!CURSOR_UPSTREAM_INTENTIONALLY_UNKNOWN_MODELS.has(modelID)) {
          failures.push(`${modelID} -> resolveCursorModel() returned unknown`);
        }
        continue;
      }

      if (CURSOR_UPSTREAM_INTENTIONALLY_UNKNOWN_MODELS.has(modelID)) {
        failures.push(`${modelID} -> resolved but still allowlisted as intentionally unknown`);
        continue;
      }

      if (resolvedModel.kind === "local") {
        if (!lookupCursorLocalCost(resolvedModel.model)) {
          failures.push(`${modelID} -> missing local Cursor pricing bucket`);
        }
        if (!resolvedPricing.ok) {
          failures.push(`${modelID} -> resolvePricingKey() was unresolved`);
        }
        continue;
      }

      const cost = lookupCost(resolvedModel.providerHint, resolvedModel.modelHint);
      if (!cost) {
        failures.push(
          `${modelID} -> missing priced snapshot key ${resolvedModel.providerHint}/${resolvedModel.modelHint}`,
        );
        continue;
      }

      if (!resolvedPricing.ok) {
        failures.push(`${modelID} -> resolvePricingKey() was unresolved`);
        continue;
      }

      if (resolvedPricing.method !== "cursor_api_alias") {
        failures.push(
          `${modelID} -> unexpected resolvePricingKey() method ${resolvedPricing.method}`,
        );
        continue;
      }

      if (
        resolvedPricing.key.provider !== resolvedModel.providerHint ||
        resolvedPricing.key.model !== resolvedModel.modelHint
      ) {
        failures.push(
          `${modelID} -> ${resolvedPricing.key.provider}/${resolvedPricing.key.model} (expected ${resolvedModel.providerHint}/${resolvedModel.modelHint})`,
        );
      }
    }

    expect(failures).toEqual([]);
  });
});
